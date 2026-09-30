package com.forge.shell;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps a live view of the daemon while the app is in the background.
 *
 * The daemon itself never stops -- it runs under systemd inside the Linux container, not in
 * this process, so turns continue whatever Android does to the UI. What is lost on switching
 * away is the event stream, and with it any way to learn that a turn finished or that Claude
 * is waiting on an answer. This service holds that stream open and turns those two moments
 * into notifications.
 */
public class ForgeService extends Service {

    public static final String ACTION_STOP = "com.forge.shell.STOP";
    public static final String ACTION_ARM = "com.forge.shell.ARM";
    public static final String ACTION_DISARM = "com.forge.shell.DISARM";
    public static final String ACTION_SHOT = "com.forge.shell.SHOT";
    public static final String ACTION_REC = "com.forge.shell.REC";
    public static final String EXTRA_RESULT = "result";
    public static final String EXTRA_DATA = "data";

    private static final String CHANNEL_STATUS = "forge_status";
    private static final String CHANNEL_ALERT = "forge_alert";
    private static final int ID_STATUS = 1;
    private static final int ID_ALERT = 2;

    /* How long the stream must stay down before we call it an outage rather than a blip.
     *
     * The daemon restarts itself for backend reloads and comes back in about two seconds, and
     * Android suspends our sockets whenever the app is backgrounded. Alerting on either would
     * train the user to ignore the notification that matters. A killed VM, by contrast, stays
     * killed until somebody starts it: measured at 37 minutes, because nothing said so. */
    private static final long OUTAGE_MS = 45000;

    private volatile boolean running = true;
    private long downSince = 0;          // first failure of the current outage, 0 if connected
    private boolean alerted = false;
    private Thread worker;
    private int lastEventId = 0;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stop();
            return START_NOT_STICKY;
        }
        createChannels();
        String action = (intent == null) ? null : intent.getAction();

        if (ACTION_ARM.equals(action)) {
            // Foreground with the mediaProjection type must come BEFORE the projection
            // starts, or Android 14+ throws SecurityException the moment it does.
            startForegroundForCapture();
            int result = intent.getIntExtra(EXTRA_RESULT, 0);
            Intent data = (Intent) intent.getParcelableExtra(EXTRA_DATA);
            boolean ok = ScreenGrabber.arm(this, result, data);
            setStatus(ok ? "Capture armed" : "Could not arm capture",
                      ok ? "Shot and Rec are ready" : "Screen capture was refused");
            return START_STICKY;
        }

        startForegroundWatching();

        if (ACTION_DISARM.equals(action)) {
            ScreenGrabber.disarm();
            setStatus("Capture off", "Watching for activity");
        } else if (ACTION_SHOT.equals(action)) {
            takeShot();
        } else if (ACTION_REC.equals(action)) {
            toggleRec();
        }
        if (worker == null) {
            worker = new Thread(new Runnable() {
                public void run() { loop(); }
            });
            worker.setDaemon(true);
            worker.start();
        }
        // START_STICKY: if Android reclaims us under memory pressure, come back on our own.
        return START_STICKY;
    }

    private void stop() {
        running = false;
        if (worker != null) worker.interrupt();
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

        // Status is deliberately silent: it updates on every turn and would be unbearable
        // otherwise. Only the alert channel is allowed to make noise.
        NotificationChannel status = new NotificationChannel(
                CHANNEL_STATUS, "Forge status", NotificationManager.IMPORTANCE_LOW);
        status.setShowBadge(false);
        nm.createNotificationChannel(status);

        NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT, "Needs you", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(alert);
    }

    private PendingIntent openApp() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, open, flags);
    }

    private Notification status(String title, String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_STATUS)
                : new Notification.Builder(this);
        Intent stopIntent = new Intent(this, ForgeService.class).setAction(ACTION_STOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopIntent, flags);

        boolean rec = CaptureService.isRunning() && CaptureService.get().isRecording();

        b.setContentTitle(title)
         .setContentText(text)
         .setContentIntent(openApp())
         .setOngoing(true)
         .setOnlyAlertOnce(true);

        /* Recording has to be legible WITHOUT opening the shade -- the complaint was having
         * no idea whether a recording was still running, and pulling the shade down to find
         * out covers the screen being recorded. The status bar icon is the only part of a
         * notification visible at all times, so it carries the state: a filled circle while
         * recording, the usual sync glyph otherwise. The chronometer gives the elapsed time
         * for when the shade IS open, which also answers "did it actually start". */
        if (rec) {
            b.setSmallIcon(android.R.drawable.presence_video_busy)
             .setUsesChronometer(true)
             .setWhen(CaptureService.get().recStartedAt());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                b.setColorized(true).setColor(0xFFD9776B);
            }
        } else {
            b.setSmallIcon(android.R.drawable.stat_notify_sync)
             .setUsesChronometer(false);
        }

        /* The shade only ever shows three actions, so they have to be the three that matter
         * right now rather than a fixed list. Disarmed, the only useful move is arming;
         * armed, it is shoot / record / put it away. "Stop watching" survives only while
         * disarmed, which is also the only state in which anyone wants it. */
        if (ScreenGrabber.isArmed()) {
            b.addAction(new Notification.Action.Builder(
                    null, "Shot", servicePi(2, ACTION_SHOT)).build());
            b.addAction(new Notification.Action.Builder(
                    null, rec ? "Stop rec" : "Rec", servicePi(3, ACTION_REC)).build());
            b.addAction(new Notification.Action.Builder(
                    null, "Disarm", servicePi(4, ACTION_DISARM)).build());
        } else {
            Intent arm = new Intent(this, ConsentActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent armPi = PendingIntent.getActivity(this, 5, arm, flags);
            b.addAction(new Notification.Action.Builder(null, "Arm capture", armPi).build());
            b.addAction(new Notification.Action.Builder(null, "Stop watching", stopPi).build());
        }
        return b.build();
    }

    private PendingIntent servicePi(int code, String action) {
        Intent i = new Intent(this, ForgeService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, code, i, flags);
    }

    /**
     * The ordinary path: watching a stream, with no projection involved.
     *
     * Must name dataSync explicitly. The two-argument startForeground() adopts every type
     * declared in the manifest, and this service declares mediaProjection alongside dataSync
     * for the capture path -- so the bare call asked for a projection type with no projection
     * behind it, which Android 14+ answers with SecurityException. That is on the normal
     * start, so the app died the moment it launched.
     */
    private void startForegroundWatching() {
        Notification n = status("Connected", "Watching for activity");
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                startForeground(ID_STATUS, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                return;
            } catch (Throwable ignored) {
                // Same reasoning as the capture path: a service without the declared type
                // beats no service at all.
            }
        }
        try {
            startForeground(ID_STATUS, n);
        } catch (Throwable ignored) {
            // Never let the notification take the app down with it.
        }
    }

    /** Re-enter the foreground declaring mediaProjection, as Android 14+ requires. */
    private void startForegroundForCapture() {
        Notification n = status("Arming capture", "Starting screen capture");
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                startForeground(ID_STATUS, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                                | android.content.pm.ServiceInfo
                                        .FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
                return;
            } catch (Throwable ignored) {
                // Fall through: better a running service without the type than no service.
            }
        }
        startForeground(ID_STATUS, n);
    }

    // ---------------------------------------------------------------- captures

    /**
     * One capture: the tree and the pixels at the same instant, as a pair of files.
     *
     * Both halves are written even when one fails, because a capture that is only half
     * present is still worth more than nothing -- and which half failed is itself the
     * diagnostic (no tree means the accessibility service is off; no image means capture
     * was never armed).
     */
    private void takeShot() {
        final String stem = "cap-" + Captures.stamp();
        Thread t = new Thread(new Runnable() {
            public void run() {
                StringBuilder head = new StringBuilder();
                head.append("# forge capture ").append(stem).append('\n');
                if (CaptureService.isRunning()) {
                    head.append(CaptureService.get().snapshot());
                } else {
                    head.append("# accessibility service is not enabled -- no tree.\n")
                        .append("# Settings > Accessibility > Forge captures.\n");
                }
                java.io.File txt = Captures.writeText(stem, head.toString());
                java.io.File jpg = Captures.writeImage(stem, ScreenGrabber.grab());
                Captures.prune();
                setStatus(jpg != null ? "Capture saved" : "Capture saved (no image)",
                          txt != null ? stem : "could not write capture");
            }
        });
        t.setDaemon(true);
        t.start();
    }

    /**
     * A recording here is an event log, not a video.
     *
     * The accessibility stream already says precisely what happened and when -- which
     * control was tapped at t=1.23, what text changed, when the window swapped -- so a
     * recording is that log plus a still at each end. That is a few hundred tokens for a
     * whole interaction, against tens of thousands for sampled video frames, and it is
     * exact where frames only imply.
     */
    private void toggleRec() {
        if (!CaptureService.isRunning()) {
            /* Write the failure out as a capture instead of only saying so in a notification
             * nobody was looking at. A recording that produces no file at all is
             * indistinguishable from one that was never started -- which is precisely how
             * two taps on Rec came to leave no trace whatsoever. */
            final String stem = "rec-" + Captures.stamp();
            Captures.writeText(stem,
                    "# forge recording " + stem + "\n"
                    + "# FAILED: the accessibility service is not connected, so there are no\n"
                    + "# events to record. Settings > Accessibility > Forge > turn it on.\n");
            Captures.writeImage(stem, ScreenGrabber.grab());
            Captures.prune();
            setStatus("Cannot record", "Turn on Forge in Accessibility settings");
            return;
        }
        final CaptureService cap = CaptureService.get();
        if (cap.isRecording()) {
            final String stem = cap.recStem();
            final String body = cap.stopRecording();
            Thread t = new Thread(new Runnable() {
                public void run() {
                    StringBuilder sb = new StringBuilder();
                    sb.append("# forge recording ").append(stem).append('\n');
                    sb.append(body);
                    sb.append("\n# state at end of recording\n");
                    sb.append(cap.snapshot());
                    Captures.writeText(stem, sb.toString());
                    Captures.prune();
                    setStatus("Recording saved", stem);
                }
            });
            t.setDaemon(true);
            t.start();
        } else {
            /* The thumbnail is taken HERE, at the start, not at the end. It is only ever a
             * visual label -- the payload is the event log -- and the screen at the moment
             * you hit record is what you were looking at when you decided to record it,
             * which is what makes one recording recognisable from another in the list. */
            final String stem = "rec-" + Captures.stamp();
            cap.startRecording(stem);
            setStatus("Recording", "Tap the shortcut button or Stop rec");
            Thread t = new Thread(new Runnable() {
                public void run() {
                    Captures.writeImage(stem, ScreenGrabber.grab());
                }
            });
            t.setDaemon(true);
            t.start();
        }
    }

    private void setStatus(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(ID_STATUS, status(title, text));
    }

    /** A separate, noisy notification: these are the moments worth interrupting someone for. */
    private void alert(String title, String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ALERT)
                : new Notification.Builder(this);
        b.setContentTitle(title)
         .setContentText(text)
         .setSmallIcon(android.R.drawable.stat_notify_chat)
         .setContentIntent(openApp())
         .setAutoCancel(true)
         .setStyle(new Notification.BigTextStyle().bigText(text));
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(ID_ALERT, b.build());
    }

    /**
     * Raise a real alert once an outage outlasts a restart.
     *
     * The service survives the app being backgrounded, which is the whole point: the VM is
     * usually killed while you are in another app, so nothing that only runs in the
     * foreground can notice. Recovery is three seconds once the Terminal starts -- the entire
     * cost of these outages is the time before anyone realises, so the notification *is* the
     * fix.
     *
     * Tapping opens Forge rather than the Terminal directly: Forge then starts the Terminal
     * itself, polls for the daemon and brings itself back to front, which leaves the user
     * where they wanted to be instead of staring at a console.
     */
    private void noteOutage() {
        long now = System.currentTimeMillis();
        if (downSince == 0) downSince = now;
        if (!alerted && now - downSince >= OUTAGE_MS) {
            alerted = true;
            alert("Forge backend stopped",
                  "The Linux Terminal is not running \u2014 Android may have reclaimed it. "
                  + "Tap to restart it.");
        }
    }

    private void clearOutage() {
        downSince = 0;
        if (alerted) {
            alerted = false;
            NotificationManager nm =
                    (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.cancel(ID_ALERT);
        }
    }

    /** Reconnecting event-stream reader. Runs until the service is stopped. */
    private void loop() {
        long backoff = 1000;
        while (running) {
            SharedPreferences prefs = getSharedPreferences("forge", Context.MODE_PRIVATE);
            String host = prefs.getString("host", null);
            String token = prefs.getString("token", null);
            if (host == null || token == null) {
                setStatus("Not paired", "Open Forge to pair this device");
                sleep(5000);
                continue;
            }
            HttpURLConnection conn = null;
            try {
                URL url = new URL("http://" + host + "/events?last_event_id=" + lastEventId);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestProperty("Authorization", "Bearer " + token);
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(0);          // the stream is long-lived by design
                conn.connect();

                if (conn.getResponseCode() == 401) {
                    setStatus("Token rejected", "Open Forge and pair again");
                    sleep(30000);
                    continue;
                }

                backoff = 1000;
                clearOutage();
                BufferedReader in = new BufferedReader(new InputStreamReader(
                        conn.getInputStream(), "UTF-8"));
                String line;
                while (running && (line = in.readLine()) != null) {
                    if (line.startsWith("id: ")) {
                        try { lastEventId = Integer.parseInt(line.substring(4).trim()); }
                        catch (NumberFormatException ignored) { }
                    } else if (line.startsWith("data: ")) {
                        handle(line.substring(6));
                    }
                }
            } catch (Exception e) {
                if (!running) return;
                setStatus("Reconnecting…", "Lost contact with the daemon");
                noteOutage();
            } finally {
                if (conn != null) conn.disconnect();
            }
            sleep(backoff);
            backoff = Math.min(backoff * 2, 30000);
        }
    }

    private void handle(String json) {
        try {
            JSONObject o = new JSONObject(json);
            // Replayed events are history. Alerting on them would fire a notification for
            // every question ever asked each time the stream reconnects.
            if (o.optBoolean("replay", false)) return;
            String kind = o.optString("kind", "");

            if ("turn_start".equals(kind)) {
                setStatus("Claude is working", "Started just now");
            } else if ("turn_end".equals(kind)) {
                setStatus("Idle", "Last turn finished");
                alert("Turn finished", "Claude has finished and is waiting for you.");
            } else if ("ask_request".equals(kind)) {
                alert("Claude asked you something", firstQuestion(o));
            } else if ("permission_request".equals(kind)) {
                alert("Permission needed", o.optString("display_name", "A tool") + " is waiting.");
            } else if ("build_end".equals(kind)) {
                alert("Build finished", o.optString("project", "APK") + " is ready to install.");
            } else if ("tool_use".equals(kind)) {
                setStatus("Claude is working", o.optString("name", "tool"));
            }
        } catch (Exception ignored) {
            // A malformed frame must never take the watcher down.
        }
    }

    private String firstQuestion(JSONObject o) {
        try {
            return o.getJSONArray("questions").getJSONObject(0).optString("question", "Tap to answer");
        } catch (Exception e) {
            return "Tap to answer";
        }
    }

    private void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
