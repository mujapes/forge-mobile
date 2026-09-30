package com.forge.shell;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;

/**
 * Thin shell around the Forge UI.
 *
 * Everything visual lives in the daemon-served web UI so it can be edited without rebuilding
 * this APK. This class only supplies what a web view cannot do on its own: pairing, and
 * handing a built APK to the system installer.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "forge";
    private static final String KEY_HOST = "host";
    private static final String KEY_TOKEN = "token";

    /** Matches --bg in the web UI, so the system bars disappear into the page. */
    private static final int BG = Color.BLACK;

    /** Drag distance, in dp, that counts as a pull-to-refresh. */
    private static final int PULL_DP = 72;

    /** A page that has not loaded within this long is not going to; say so. */
    private static final long LOAD_TIMEOUT_MS = 7000;

    private WebView web;
    private SharedPreferences prefs;
    private float pullStartY = -1;

    private android.widget.FrameLayout root;
    private TextView status;
    private boolean pageLoaded = false;
    private boolean askedNotify = false;
    private boolean triedDiscovery;
    private boolean triedBaked = false;
    private boolean autoStartTried = false;   // one automatic Terminal launch per run
    private final android.os.Handler ui = new android.os.Handler();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        // The whole point of shipping a shell rather than a browser tab: the status and
        // navigation bars are ours, so the page runs edge to edge in one colour instead of
        // floating between a white URL bar and a grey nav bar.
        android.view.Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        window.getDecorView().setBackgroundColor(BG);

        /* No native selection UI at all.
         *
         * Safe to do only now that the page owns selection: an earlier attempt suppressed
         * this while the composer was still a textarea, and since Chromium ties its drag
         * handles to the action mode, that removed the ability to select text at all. With
         * the composer editable the page draws its own handles and menu, so what is left here
         * is a duplicate -- and a duplicate that renders in Android's blue over ours.
         *
         * Both startActionMode overloads for anything the WebView raises itself, and both
         * startActionModeForChild overloads because Chromium starts text selection from an
         * internal child view, which routes through the ViewGroup.
         */
        web = new WebView(this) {
            @Override
            public android.view.ActionMode startActionMode(
                    android.view.ActionMode.Callback callback) {
                return null;
            }

            @Override
            public android.view.ActionMode startActionMode(
                    android.view.ActionMode.Callback callback, int type) {
                return null;
            }

            @Override
            public android.view.ActionMode startActionModeForChild(
                    android.view.View originalView,
                    android.view.ActionMode.Callback callback) {
                return null;
            }

            @Override
            public android.view.ActionMode startActionModeForChild(
                    android.view.View originalView,
                    android.view.ActionMode.Callback callback, int type) {
                return null;
            }
        };
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "Forge");

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            /**
             * Forge's own pages load here; everything else goes to a real browser.
             *
             * Without this the WebView simply navigates itself to whatever was tapped, so a
             * link in the transcript replaced the entire app with a remote page -- no
             * header, no composer, and nothing to get back with but that site's own
             * navigation. `target="_blank"` does not help: a WebView without
             * setSupportMultipleWindows loads blank targets in place.
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternally(request.getUrl() != null
                                      ? request.getUrl().toString() : null);
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternally(url);     // pre-API-24 path
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                hideStatus();
                // Only once the page has actually loaded do we know host and token are good,
                // which is exactly what the watcher needs to connect.
                startWatcher();
                reportHostApp();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    retryOrSetup("Can't reach " + host() + "\n\n"
                            + (error != null ? error.getDescription() : "connection failed"));
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                // A stored token the daemon no longer accepts looks exactly like a hang
                // otherwise: the page never paints and nothing explains why.
                if (request.isForMainFrame() && response != null
                        && response.getStatusCode() == 401) {
                    showSetup("The saved token was rejected. Pair again.");
                }
            }
        });

        // There is no browser chrome here, so there is no reload button either. Without a
        // gesture the only way out of a wedged page would be force-stopping the app.
        installPullToRefresh();

        // A bare WebView that fails to load is an unexplained black rectangle -- no error, no
        // address, nothing to act on. The status layer guarantees there is always something
        // on screen saying what the app is doing.
        status = new TextView(this);
        status.setTextColor(0xFFB8B0A8);
        status.setTextSize(15);
        status.setGravity(android.view.Gravity.CENTER);
        status.setBackgroundColor(BG);
        int pad = (int) (28 * getResources().getDisplayMetrics().density);
        status.setPadding(pad, pad, pad, pad);

        root = new android.widget.FrameLayout(this);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(status, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Credentials are compiled in (tools/gen_app_config.py), because the daemon and this
        // APK are built on the same device -- there is nothing for a pairing code to
        // establish. The dialog survives only as a fallback for when the baked address is
        // stale, which is the one case this cannot solve on its own.
        adoptBakedCredentials();

        if (token() == null || host() == null) {
            showStatus("Not paired yet");
            showSetup(null);
        } else {
            load();
        }
    }

    private void adoptBakedCredentials() {
        if (token() != null && host() != null) return;   // a real pairing always wins
        String bakedHost = getString(R.string.default_host);
        String bakedToken = getString(R.string.default_token);
        if (bakedHost == null || bakedHost.isEmpty()
                || bakedToken == null || bakedToken.isEmpty()) {
            return;
        }
        prefs.edit().putString(KEY_HOST, bakedHost).putString(KEY_TOKEN, bakedToken).apply();
    }

    private static final String KEY_HOST_APP = "host_app";

    /** Package-name fragments that identify a Linux-VM host app on any build. */
    private static final String[] HOST_HINTS = { "terminal", "virtualization", "vmlauncher" };

    /**
     * Find the app that hosts the Linux VM, without hardcoding a vendor's package name.
     *
     * Three tiers, narrowest first: a package the user already chose, then the known
     * candidates, then a scan of everything launchable whose name looks like a VM host. The
     * scan is what makes this survive a rename or a different OEM -- the candidate list is
     * only a fast path, not the contract.
     */
    private String resolveHostApp() {
        String saved = prefs.getString(KEY_HOST_APP, null);
        if (saved != null && launchIntentFor(saved) != null) return saved;

        for (int i = 0; i < TERMINAL_PACKAGES.length; i++) {
            if (launchIntentFor(TERMINAL_PACKAGES[i]) != null) return TERMINAL_PACKAGES[i];
        }

        java.util.List<String> found = scanForHostApps();
        if (found.size() == 1) return found.get(0);
        return null;   // none, or ambiguous -- the caller offers a picker
    }

    private Intent launchIntentFor(String pkg) {
        try {
            return getPackageManager().getLaunchIntentForPackage(pkg);
        } catch (Exception e) {
            return null;
        }
    }

    /** Every launchable package whose name hints at a Linux/VM host. */
    private java.util.List<String> scanForHostApps() {
        java.util.List<String> out = new java.util.ArrayList<String>();
        try {
            Intent launcher = new Intent(Intent.ACTION_MAIN);
            launcher.addCategory(Intent.CATEGORY_LAUNCHER);
            java.util.List<android.content.pm.ResolveInfo> apps =
                    getPackageManager().queryIntentActivities(launcher, 0);
            for (int i = 0; i < apps.size(); i++) {
                String pkg = apps.get(i).activityInfo.packageName;
                String low = pkg.toLowerCase();
                for (int h = 0; h < HOST_HINTS.length; h++) {
                    if (low.contains(HOST_HINTS[h]) && !out.contains(pkg)) {
                        out.add(pkg);
                        break;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private Intent terminalIntent() {
        String pkg = resolveHostApp();
        if (pkg == null) return null;
        prefs.edit().putString(KEY_HOST_APP, pkg).apply();
        return launchIntentFor(pkg);
    }

    /**
     * Report what discovery found, so the VM side can see the answer it cannot look up.
     * Fire-and-forget: this is diagnostics, never a reason to block or fail a launch.
     */
    private void reportHostApp() {
        new Thread(new Runnable() {
            public void run() {
                try {
                    // Resolve here rather than reading the stored value: discovery otherwise
                    // only runs when the trouble dialog opens, so on a healthy launch nothing
                    // is ever saved and the report says "null".
                    String resolved = resolveHostApp();
                    if (resolved != null) prefs.edit().putString(KEY_HOST_APP, resolved).apply();

                    org.json.JSONObject body = new org.json.JSONObject();
                    body.put("resolved_host_app", String.valueOf(resolved));
                    body.put("candidates_matched", new org.json.JSONArray(scanForHostApps()));
                    body.put("android_sdk", Build.VERSION.SDK_INT);
                    body.put("device", Build.MODEL);

                    HttpURLConnection c = (HttpURLConnection)
                            new URL("http://" + host() + "/diag").openConnection();
                    c.setRequestMethod("POST");
                    c.setRequestProperty("Content-Type", "application/json");
                    c.setRequestProperty("Authorization", "Bearer " + token());
                    c.setConnectTimeout(4000);
                    c.setDoOutput(true);
                    OutputStream out = c.getOutputStream();
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    out.close();
                    c.getResponseCode();
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
        }).start();
    }

    /**
     * What to show when the daemon is unreachable.
     *
     * The old behaviour was to show the pairing dialog, which diagnosed the problem correctly
     * and then offered a remedy for a different one: credentials are compiled in, so a
     * six-digit code could never help. The actual fix is almost always "the Linux VM is not
     * running", so that is the button.
     */
    private void showTrouble(String message) {
        final Intent terminal = terminalIntent();
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("Forge isn't running")
                .setMessage((message != null ? message + "\n\n" : "")
                        + "Nothing is listening on " + host() + ".\n\n"
                        + (terminal != null
                            ? "Forge lives inside the Linux Terminal. Starting it will boot "
                              + "the daemon, then this will reconnect on its own."
                            : "Open the Linux Terminal app to start the daemon, then retry."))
                .setCancelable(false);

        if (terminal != null) {
            b.setPositiveButton("Start Terminal",
                    new android.content.DialogInterface.OnClickListener() {
                public void onClick(android.content.DialogInterface d, int which) {
                    terminal.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        startActivity(terminal);
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this,
                                "Could not open Terminal: " + e.getMessage(),
                                Toast.LENGTH_LONG).show();
                    }
                    waitForDaemon();
                }
            });
            b.setNeutralButton("Retry", new android.content.DialogInterface.OnClickListener() {
                public void onClick(android.content.DialogInterface d, int which) { load(); }
            });
            // The daemon's address is DHCP-assigned and has moved three times. When it
            // moves, nothing answers, so the paths that reach setup -- a 401, or the baked
            // host differing -- never fire, and the address dialog becomes unreachable
            // exactly when it is the only thing that would help.
            b.setNegativeButton("Change address",
                    new android.content.DialogInterface.OnClickListener() {
                public void onClick(android.content.DialogInterface d, int which) {
                    showSetup(null);
                }
            });
        } else {
            b.setPositiveButton("Retry", new android.content.DialogInterface.OnClickListener() {
                public void onClick(android.content.DialogInterface d, int which) { load(); }
            });
        }

        // Pairing survives only here: the rare case where the address genuinely moved.
        b.setNegativeButton("Change address",
                new android.content.DialogInterface.OnClickListener() {
            public void onClick(android.content.DialogInterface d, int which) {
                showSetup(null);
            }
        });
        b.show();
    }

    /**
     * Poll /health until the VM finishes booting, then load.
     *
     * Booting the VM takes appreciably longer than a page load, so retrying once would just
     * fail again and put the user back in a dialog.
     */
    private void waitForDaemon() {
        showStatus("Starting Linux\u2026\n\nWaiting for Forge to come up.");
        pollHealth(0);
    }

    private void pollHealth(final int attempt) {
        if (attempt > 45) {          // ~90s, well past a normal cold boot
            // A daemon that never answers is usually a moved address rather than a dead
            // VM, so look for it before handing the user a dialog about it.
            if (!triedDiscovery) {
                triedDiscovery = true;
                discover();
                return;
            }
            showTrouble("Gave up waiting for the daemon.");
            return;
        }
        new Thread(new Runnable() {
            public void run() {
                boolean up = false;
                try {
                    HttpURLConnection c = (HttpURLConnection)
                            new URL("http://" + host() + "/health").openConnection();
                    c.setConnectTimeout(1500);
                    c.setReadTimeout(1500);
                    up = c.getResponseCode() == 200;
                    c.disconnect();
                } catch (Exception ignored) {
                }
                final boolean ready = up;
                runOnUiThread(new Runnable() {
                    public void run() {
                        if (ready) {
                            // Starting the Terminal put it in front of us. Once the daemon
                            // answers there is nothing to see there, so come back: singleTask
                            // means this re-uses the existing task rather than stacking.
                            if (autoStartTried) {
                                Intent self = new Intent(MainActivity.this, MainActivity.class);
                                self.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                                try { startActivity(self); } catch (Exception ignored) { }
                            }
                            load();
                        }
                        else ui.postDelayed(new Runnable() {
                            public void run() { pollHealth(attempt + 1); }
                        }, 2000);
                    }
                });
            }
        }).start();
    }

    /**
     * A failed connection is usually a moved LAN address, not a broken install.
     *
     * Reinstalling picks up freshly baked credentials, but stored prefs would shadow them
     * forever. So on failure, if the baked address differs from the stored one, switch to it
     * and try once more before troubling the user.
     */
    private void retryOrSetup(String message) {
        String bakedHost = getString(R.string.default_host);
        String bakedToken = getString(R.string.default_token);
        boolean haveBaked = bakedHost != null && !bakedHost.isEmpty();
        if (haveBaked && !triedBaked && !bakedHost.equals(host())) {
            triedBaked = true;
            prefs.edit().putString(KEY_HOST, bakedHost).putString(KEY_TOKEN, bakedToken).apply();
            showStatus("Trying " + bakedHost + "…");
            load();
            return;
        }
        if (!autoStartTerminal()) showTrouble(message);
    }

    /**
     * Start the Linux Terminal ourselves rather than asking permission to.
     *
     * The daemon being down has exactly one cure, and a dialog offering to apply it is a
     * tap between the user and the only thing that can happen next. Worse, it is modal: miss
     * it, or dismiss it while switching apps, and the app looks broken -- which is how the
     * VM being reclaimed turned into "I had to open Terminal manually".
     *
     * Once per launch. If the daemon is still absent after starting the Terminal, something
     * is wrong that another launch will not fix, and the dialog is the right answer then.
     */
    private boolean autoStartTerminal() {
        if (autoStartTried) return false;
        Intent terminal = terminalIntent();
        if (terminal == null) return false;
        autoStartTried = true;
        terminal.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(terminal);
        } catch (Exception e) {
            return false;
        }
        waitForDaemon();
        return true;
    }

    /** Idempotent: notify() may be called before the watcher service has ever started. */
    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        android.app.NotificationManager nm =
                (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel("forge_status") == null) {
            nm.createNotificationChannel(new android.app.NotificationChannel(
                    "forge_status", "Forge status",
                    android.app.NotificationManager.IMPORTANCE_LOW));
        }
        if (nm.getNotificationChannel("forge_alert") == null) {
            nm.createNotificationChannel(new android.app.NotificationChannel(
                    "forge_alert", "Needs you",
                    android.app.NotificationManager.IMPORTANCE_HIGH));
        }
    }

    /**
     * True when the URL was handed to another app, meaning the WebView must not load it.
     *
     * "Ours" is the daemon we are paired with, so the UI, its assets and anything it serves
     * still navigate normally in place.
     */
    private boolean openExternally(String url) {
        if (url == null) return false;
        String h = host();
        if (h != null && url.startsWith("http://" + h)) return false;   // Forge itself
        if (url.startsWith("about:") || url.startsWith("javascript:")) return false;

        try {
            Intent browser = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url));
            browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(browser);
        } catch (Exception e) {
            Toast.makeText(this, "No app can open that link", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void showStatus(String text) {
        status.setText(text + "\n\n(tap to change address)");
        status.setVisibility(View.VISIBLE);
        // Waiting is the state you are stuck in when the address is wrong, so the escape
        // hatch belongs here too -- not only behind the 90-second timeout.
        status.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showSetup(null); }
        });
    }

    private void hideStatus() {
        status.setVisibility(View.GONE);
    }

    /**
     * Pull down at the top of the page to reload.
     *
     * Deliberately hand-rolled: SwipeRefreshLayout lives in AndroidX and this build has no
     * AndroidX dependency, which is also what keeps the APK at ~17 KB.
     */
    /**
     * Pull-to-refresh lives in the page, not here.
     *
     * This used to gate on web.getScrollY() == 0, which sounds right and is always true: the
     * page scrolls an inner #feed element, so the WebView itself never scrolls at all. Every
     * downward drag therefore counted as a pull, and the app reloaded while the user was
     * simply typing. Only the page knows whether the transcript is at the top, so the gesture
     * belongs there -- and it calls Forge.reload() when it fires.
     */
    private void installPullToRefresh() {
        // Intentionally empty: retained so the call site documents where the gesture went.
    }

    /** The Linux Terminal hosts the daemon. Names vary by build, so try each. */
    private static final String[] TERMINAL_PACKAGES = {
        "com.android.virtualization.terminal",
        "com.google.android.virtualization.terminal",
        "com.android.virtualization.vmlauncher",
        "com.google.android.virtualization.vmlauncher",
    };

    private static final int REQ_VOICE = 1001;
    private static final int REQ_NOTIFY = 1002;

    /**
     * Start the background watcher, asking for notification permission first if needed.
     *
     * Without POST_NOTIFICATIONS (Android 13+) the service still runs, but every alert is
     * silently dropped -- which would look exactly like the feature not working.
     */
    private void startWatcher() {
        // askedNotify guards a loop: on denial this method is called again from the result
        // callback, and would otherwise re-prompt forever. Denied means run without alerts.
        if (!askedNotify && Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                   != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            askedNotify = true;
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
            return;   // resumed from onRequestPermissionsResult
        }
        try {
            Intent svc = new Intent(this, ForgeService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
            else startService(svc);
        } catch (Exception e) {
            Toast.makeText(this, "Background watcher failed: " + e.getMessage(),
                    Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIFY) startWatcher();
    }

    private void startVoice() {
        try {
            Intent intent = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Speak to Forge");
            startActivityForResult(intent, REQ_VOICE);
        } catch (Exception e) {
            Toast.makeText(this, "No speech recogniser available on this device",
                    Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_VOICE || resultCode != RESULT_OK || data == null) return;
        java.util.ArrayList<String> hits = data.getStringArrayListExtra(
                android.speech.RecognizerIntent.EXTRA_RESULTS);
        if (hits == null || hits.isEmpty()) return;
        // JSON-encode so quotes and backslashes in the transcript cannot break out of the call.
        String json = org.json.JSONObject.quote(hits.get(0));
        web.evaluateJavascript("window.forgeVoiceResult && window.forgeVoiceResult("
                + json + ")", null);
    }

    private void reload() {
        Toast.makeText(this, "Reloading…", Toast.LENGTH_SHORT).show();
        web.reload();
    }

    private String host() { return prefs.getString(KEY_HOST, null); }
    private String token() { return prefs.getString(KEY_TOKEN, null); }

    private void load() {
        pageLoaded = false;
        showStatus("Connecting to " + host() + "…");
        web.loadUrl("http://" + host() + "/?token=" + token());

        // An unreachable host does not fail fast -- the TCP connect just sits there, which is
        // exactly how this presented as a permanently blank screen. Time it out ourselves.
        ui.postDelayed(new Runnable() {
            public void run() {
                if (!pageLoaded) {
                    retryOrSetup("No response from " + host() + " after 7s.\n\n"
                            + "Check the daemon is running, and that this address is current.");
                }
            }
        }, LOAD_TIMEOUT_MS);
    }

    /**
     * Offer Back to the page before acting on it.
     *
     * Closing a sheet, dismissing the keyboard, leaving a view -- all of that lives in JS, and
     * hardcoding it here would put navigation behind a rebuild. The page returns "true" to say
     * it handled it.
     */
    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript(
                "(function(){try{return window.forgeOnBack?String(window.forgeOnBack()):'false';}"
                + "catch(e){return 'false';}})()",
                new android.webkit.ValueCallback<String>() {
                    public void onReceiveValue(String value) {
                        if (value != null && value.contains("true")) return;   // page handled it
                        if (web.canGoBack()) web.goBack();
                        else finish();
                    }
                });
    }

    /** First-run pairing: an address and a six-digit code, exchanged for the real token. */
    private void showSetup(String message) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);

        if (message != null) {
            TextView warn = new TextView(this);
            warn.setText(message);
            warn.setPadding(0, 0, 0, pad / 2);
            box.addView(warn);
        }

        final EditText hostField = new EditText(this);
        hostField.setHint(getString(R.string.default_host));
        hostField.setSingleLine(true);
        String existing = host();
        hostField.setText(existing != null ? existing : getString(R.string.default_host));
        box.addView(hostField);

        final boolean havePaired = token() != null && !token().isEmpty();

        final EditText codeField = new EditText(this);
        // Already paired means the token is still good; only the address moved. Demanding a
        // fresh code for that sends the user to a terminal to read a number they do not
        // need, which is exactly when Forge is hardest to get to.
        codeField.setHint(havePaired ? "pairing code (only if the token was reset)"
                                     : "six-digit pairing code");
        codeField.setSingleLine(true);
        codeField.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        box.addView(codeField);

        new AlertDialog.Builder(this)
                .setTitle("Connect to Forge")
                .setView(box)
                .setCancelable(false)
                .setPositiveButton(havePaired ? "Save" : "Pair",
                        new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface dialog, int which) {
                        final String h = hostField.getText().toString().trim();
                        final String code = codeField.getText().toString().trim();
                        new Thread(new Runnable() {
                            public void run() {
                                if (code.isEmpty() && havePaired) reuseToken(h);
                                else pair(h, code);
                            }
                        }).start();
                    }
                })
                .setNeutralButton("Find it", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface dialog, int which) {
                        discover();
                    }
                })
                .show();
    }

    /**
     * Find the daemon on the local network instead of asking the user where it went.
     *
     * The VM's address is DHCP-assigned by the host and has moved three times
     * (10.35.119.237 then 10.159.113.237 then 10.55.215.237). The phone is always on the same
     * /24, so its own address tells us where to look, and the VM has taken .237 every time
     * -- so try that first and only sweep if it misses. Probing is against /state with the
     * token, not /health, so a stranger's web server on :8787 cannot be mistaken for Forge.
     */
    private void discover() {
        showStatus("Looking for Forge on this network\u2026");
        new Thread(new Runnable() {
            public void run() { discoverBlocking(); }
        }).start();
    }

    private void discoverBlocking() {
        final String tok = token();
        final String port = portOf(host());
        java.util.List<String> candidates = new java.util.ArrayList<String>();
        for (String prefix : localPrefixes()) {
            candidates.add(prefix + "237:" + port);          // where it has always been
        }
        for (String prefix : localPrefixes()) {
            for (int i = 1; i < 255; i++) {
                if (i == 237) continue;
                candidates.add(prefix + i + ":" + port);
            }
        }

        final java.util.concurrent.atomic.AtomicReference<String> hit =
                new java.util.concurrent.atomic.AtomicReference<String>();
        java.util.concurrent.ExecutorService pool =
                java.util.concurrent.Executors.newFixedThreadPool(24);
        for (final String candidate : candidates) {
            pool.submit(new Runnable() {
                public void run() {
                    if (hit.get() != null) return;           // someone already won
                    if (probe(candidate, tok)) hit.compareAndSet(null, candidate);
                }
            });
        }
        pool.shutdown();
        try {
            pool.awaitTermination(25, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
        pool.shutdownNow();

        final String found = hit.get();
        runOnUiThread(new Runnable() {
            public void run() {
                if (found != null) {
                    prefs.edit().putString(KEY_HOST, found).apply();
                    Toast.makeText(MainActivity.this, "Found Forge at " + found,
                            Toast.LENGTH_SHORT).show();
                    load();
                } else {
                    showSetup("Could not find Forge on this network.\n\n"
                              + "Check the Linux Terminal is running.");
                }
            }
        });
    }

    /** "10.55.215." for every non-loopback IPv4 this device holds. */
    private java.util.List<String> localPrefixes() {
        java.util.List<String> out = new java.util.ArrayList<String>();
        try {
            java.util.Enumeration<java.net.NetworkInterface> ifs =
                    java.net.NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                java.net.NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress a = addrs.nextElement();
                    if (a.isLoopbackAddress() || !(a instanceof java.net.Inet4Address)) continue;
                    String ip = a.getHostAddress();
                    int cut = ip.lastIndexOf('.');
                    if (cut > 0) {
                        String prefix = ip.substring(0, cut + 1);
                        if (!out.contains(prefix)) out.add(prefix);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private String portOf(String hostPort) {
        if (hostPort != null) {
            int c = hostPort.lastIndexOf(':');
            if (c > 0 && c < hostPort.length() - 1) return hostPort.substring(c + 1);
        }
        return "8787";
    }

    /** Point the existing token at a new address, after checking it is accepted there. */
    private void reuseToken(final String host) {
        if (!probe(host, token())) {
            runOnUiThread(new Runnable() {
                public void run() {
                    showSetup("Nothing usable at " + host
                              + ".\n\nCheck the address, or enter a pairing code.");
                }
            });
            return;
        }
        prefs.edit().putString(KEY_HOST, host).apply();
        runOnUiThread(new Runnable() {
            public void run() { load(); }
        });
    }

    /**
     * Is a daemon at this address that accepts this token?
     *
     * /health is unauthenticated, so it proves something is listening but not that our
     * credentials work there. /state answering 200 proves both, which is what a saved token
     * against a moved address needs to establish.
     */
    private boolean probe(String host, String tok) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + host + "/state").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1200);
            if (tok != null && !tok.isEmpty()) {
                c.setRequestProperty("Authorization", "Bearer " + tok);
            }
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void pair(String host, String code) {
        try {
            HttpURLConnection conn = (HttpURLConnection)
                    new URL("http://" + host + "/pair").openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(new JSONObject().put("code", code)
                        .toString().getBytes(StandardCharsets.UTF_8));
            }

            int status = conn.getResponseCode();
            String body = read(status < 400 ? conn.getInputStream() : conn.getErrorStream());

            if (status == 200) {
                String token = new JSONObject(body).getString("token");
                prefs.edit().putString(KEY_HOST, host).putString(KEY_TOKEN, token).apply();
                runOnUiThread(new Runnable() {
                    public void run() { load(); }
                });
            } else {
                final String detail = body;
                runOnUiThread(new Runnable() {
                    public void run() { showSetup("Pairing failed: " + detail); }
                });
            }
        } catch (Exception e) {
            final String detail = e.getMessage();
            runOnUiThread(new Runnable() {
                public void run() { showSetup("Could not reach " + host + ": " + detail); }
            });
        }
    }

    private String read(java.io.InputStream in) {
        if (in == null) return "";
        try (Scanner scanner = new Scanner(in, "UTF-8").useDelimiter("\\A")) {
            return scanner.hasNext() ? scanner.next() : "";
        }
    }

    private class Bridge {
        /** Called from the web UI when a build finishes and the user taps Install. */
        @android.webkit.JavascriptInterface
        public void install(String path) {
            File apk = new File(path);
            if (!apk.exists()) {
                toast("APK not found at " + path);
                return;
            }
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(ApkProvider.uriFor(apk),
                        "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception e) {
                toast("Install failed: " + e.getMessage());
            }
        }

        /**
         * Hold the screen awake while a turn is running.
         *
         * A long agentic turn has no touch input, so the screen sleeps mid-run and the user
         * comes back unable to tell how far it got. A browser tab cannot ask for this.
         */
        @android.webkit.JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(new Runnable() {
                public void run() {
                    if (on) {
                        getWindow().addFlags(
                                android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        getWindow().clearFlags(
                                android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                }
            });
        }

        /**
         * Hand dictation back to the in-page keyboard.
         *
         * An HTML keyboard has no mic, and this user types largely by voice. ACTION_RECOGNIZE_SPEECH
         * launches the system recogniser, so Android owns the permission prompt and the UI and
         * this app needs neither RECORD_AUDIO nor any runtime-permission plumbing.
         */
        @android.webkit.JavascriptInterface
        public void voiceInput() {
            runOnUiThread(new Runnable() {
                public void run() { startVoice(); }
            });
        }

        /** Lets the web UI's "UI updated" banner reload the shell itself. */
        @android.webkit.JavascriptInterface
        public void reload() {
            runOnUiThread(new Runnable() {
                public void run() { web.reload(); }
            });
        }

        @android.webkit.JavascriptInterface
        public void reconnect() {
            runOnUiThread(new Runnable() {
                public void run() { showSetup(null); }
            });
        }

        /* ---------------------------------------------------------------
         * Generic primitives.
         *
         * Everything above is a purpose-built method, and each one cost an APK rebuild and a
         * manual install. These four cover the same ground generically, so new capabilities
         * compose in hot-reloading JS instead: launch any intent, post any notification, read
         * any fact, touch any file. The point is that tier 3 stops being a bottleneck.
         *
         * No allowlist, by explicit request. The page is served by the user's own daemon on
         * their own LAN, so the trust boundary is the device -- but this is a real surface,
         * and narrowing it is the first thing to do if this is ever shared.
         * --------------------------------------------------------------- */

        /** Facts about the Android side the VM cannot see. Returns JSON, synchronously. */
        @android.webkit.JavascriptInterface
        public String query(String what) {
            try {
                JSONObject out = new JSONObject();
                if ("device".equals(what)) {
                    out.put("model", Build.MODEL);
                    out.put("manufacturer", Build.MANUFACTURER);
                    out.put("sdk", Build.VERSION.SDK_INT);
                    out.put("release", Build.VERSION.RELEASE);
                } else if ("packages".equals(what)) {
                    org.json.JSONArray arr = new org.json.JSONArray();
                    Intent launcher = new Intent(Intent.ACTION_MAIN);
                    launcher.addCategory(Intent.CATEGORY_LAUNCHER);
                    java.util.List<android.content.pm.ResolveInfo> apps =
                            getPackageManager().queryIntentActivities(launcher, 0);
                    for (int i = 0; i < apps.size(); i++) {
                        android.content.pm.ResolveInfo ri = apps.get(i);
                        JSONObject o = new JSONObject();
                        o.put("package", ri.activityInfo.packageName);
                        o.put("label", String.valueOf(ri.loadLabel(getPackageManager())));
                        arr.put(o);
                    }
                    out.put("items", arr);
                } else if ("notifications".equals(what)) {
                    android.app.NotificationManager nm = (android.app.NotificationManager)
                            getSystemService(NOTIFICATION_SERVICE);
                    out.put("enabled", nm.areNotificationsEnabled());
                } else {
                    out.put("error", "unknown query: " + what);
                }
                return out.toString();
            } catch (Exception e) {
                return "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /**
         * Fire an arbitrary Intent.
         *
         * {action, package, uri, type, extras:{k:v}, chooser:bool}
         */
        @android.webkit.JavascriptInterface
        public String launch(String json) {
            try {
                JSONObject spec = new JSONObject(json);
                Intent intent;
                String pkg = spec.optString("package", "");
                String action = spec.optString("action", "");

                if (!pkg.isEmpty() && action.isEmpty()) {
                    intent = getPackageManager().getLaunchIntentForPackage(pkg);
                    if (intent == null) return "{\"ok\":false,\"error\":\"no such package\"}";
                } else {
                    intent = new Intent(action.isEmpty() ? Intent.ACTION_VIEW : action);
                    if (!pkg.isEmpty()) intent.setPackage(pkg);
                }

                String uri = spec.optString("uri", "");
                String type = spec.optString("type", "");
                if (!uri.isEmpty() && !type.isEmpty()) {
                    intent.setDataAndType(Uri.parse(uri), type);
                } else if (!uri.isEmpty()) {
                    intent.setData(Uri.parse(uri));
                } else if (!type.isEmpty()) {
                    intent.setType(type);
                }

                JSONObject extras = spec.optJSONObject("extras");
                if (extras != null) {
                    java.util.Iterator<String> keys = extras.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        Object v = extras.get(k);
                        if (v instanceof Integer) intent.putExtra(k, ((Integer) v).intValue());
                        else if (v instanceof Boolean) intent.putExtra(k, ((Boolean) v).booleanValue());
                        else intent.putExtra(k, String.valueOf(v));
                    }
                }

                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                final Intent go = spec.optBoolean("chooser", false)
                        ? Intent.createChooser(intent, spec.optString("title", "Open with"))
                        : intent;
                go.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                runOnUiThread(new Runnable() {
                    public void run() { startActivity(go); }
                });
                return "{\"ok\":true}";
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /** Post a notification. {id, title, text, channel:"status"|"alert", ongoing:bool} */
        @android.webkit.JavascriptInterface
        public String notify(String json) {
            try {
                ensureChannels();
                JSONObject spec = new JSONObject(json);
                String channel = "alert".equals(spec.optString("channel", "alert"))
                        ? "forge_alert" : "forge_status";
                Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                        ? new Notification.Builder(MainActivity.this, channel)
                        : new Notification.Builder(MainActivity.this);
                b.setContentTitle(spec.optString("title", "Forge"))
                 .setContentText(spec.optString("text", ""))
                 .setSmallIcon(android.R.drawable.stat_notify_chat)
                 .setAutoCancel(!spec.optBoolean("ongoing", false))
                 .setOngoing(spec.optBoolean("ongoing", false))
                 .setStyle(new Notification.BigTextStyle().bigText(spec.optString("text", "")));
                android.app.NotificationManager nm = (android.app.NotificationManager)
                        getSystemService(NOTIFICATION_SERVICE);
                nm.notify(spec.optInt("id", 900), b.build());
                return "{\"ok\":true}";
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /** {op:"read"|"write"|"list"|"exists"|"delete", path, data}. Text only; JSON back. */
        @android.webkit.JavascriptInterface
        public String file(String json) {
            try {
                JSONObject spec = new JSONObject(json);
                String op = spec.optString("op", "read");
                File f = new File(spec.optString("path", ""));
                JSONObject out = new JSONObject();

                if ("exists".equals(op)) {
                    out.put("exists", f.exists());
                } else if ("list".equals(op)) {
                    org.json.JSONArray arr = new org.json.JSONArray();
                    String[] names = f.list();
                    if (names != null) for (int i = 0; i < names.length; i++) arr.put(names[i]);
                    out.put("items", arr);
                } else if ("read".equals(op)) {
                    Scanner sc = new Scanner(f, "UTF-8").useDelimiter("\\A");
                    out.put("data", sc.hasNext() ? sc.next() : "");
                    sc.close();
                } else if ("write".equals(op)) {
                    if (f.getParentFile() != null) f.getParentFile().mkdirs();
                    java.io.FileOutputStream os = new java.io.FileOutputStream(f);
                    os.write(spec.optString("data", "").getBytes(StandardCharsets.UTF_8));
                    os.close();
                    out.put("ok", true);
                } else if ("delete".equals(op)) {
                    out.put("ok", f.delete());
                } else {
                    out.put("error", "unknown op: " + op);
                }
                return out.toString();
            } catch (Exception e) {
                return "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /** {keepAwake, statusBar, navBar, immersive} -- any subset. Colours as #rrggbb. */
        @android.webkit.JavascriptInterface
        public String window(String json) {
            try {
                final JSONObject spec = new JSONObject(json);
                runOnUiThread(new Runnable() {
                    public void run() {
                        try {
                            android.view.Window w = getWindow();
                            if (spec.has("statusBar"))
                                w.setStatusBarColor(Color.parseColor(spec.optString("statusBar")));
                            if (spec.has("navBar"))
                                w.setNavigationBarColor(Color.parseColor(spec.optString("navBar")));
                            if (spec.has("keepAwake")) {
                                if (spec.optBoolean("keepAwake"))
                                    w.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                                else
                                    w.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            }
                            if (spec.has("immersive")) {
                                View dv = w.getDecorView();
                                dv.setSystemUiVisibility(spec.optBoolean("immersive")
                                        ? (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                           | View.SYSTEM_UI_FLAG_FULLSCREEN
                                           | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION)
                                        : 0);
                            }
                        } catch (Exception ignored) {
                        }
                    }
                });
                return "{\"ok\":true}";
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /** Request any manifest-declared runtime permission. JS re-queries for the result. */
        @android.webkit.JavascriptInterface
        public String permission(final String name) {
            try {
                if (Build.VERSION.SDK_INT < 23) return "{\"granted\":true}";
                boolean granted = checkSelfPermission(name)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED;
                if (!granted) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            requestPermissions(new String[]{ name }, 1100);
                        }
                    });
                }
                return "{\"granted\":" + granted + "}";
            } catch (Exception e) {
                return "{\"granted\":false,\"error\":"
                        + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /** WebView settings at runtime: {userAgent, textZoom, mediaAutoplay}. */
        @android.webkit.JavascriptInterface
        public String webview(String json) {
            try {
                final JSONObject spec = new JSONObject(json);
                runOnUiThread(new Runnable() {
                    public void run() {
                        WebSettings ws = web.getSettings();
                        if (spec.has("userAgent")) ws.setUserAgentString(spec.optString("userAgent"));
                        if (spec.has("textZoom")) ws.setTextZoom(spec.optInt("textZoom", 100));
                        if (spec.has("mediaAutoplay"))
                            ws.setMediaPlaybackRequiresUserGesture(!spec.optBoolean("mediaAutoplay"));
                    }
                });
                return "{\"ok\":true}";
            } catch (Exception e) {
                return "{\"ok\":false}";
            }
        }

        /** {op:"get"} or {op:"set", text}. The VM and Android share no clipboard otherwise. */
        @android.webkit.JavascriptInterface
        public String clipboard(String json) {
            try {
                JSONObject spec = new JSONObject(json);
                android.content.ClipboardManager cm = (android.content.ClipboardManager)
                        getSystemService(CLIPBOARD_SERVICE);
                if ("set".equals(spec.optString("op", "get"))) {
                    cm.setPrimaryClip(android.content.ClipData.newPlainText(
                            "forge", spec.optString("text", "")));
                    return "{\"ok\":true}";
                }
                CharSequence text = "";
                if (cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                    text = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                }
                return "{\"text\":" + JSONObject.quote(String.valueOf(text)) + "}";
            } catch (Exception e) {
                return "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        @android.webkit.JavascriptInterface
        public void vibrate(int ms) {
            try {
                android.os.Vibrator v = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(android.os.VibrationEffect.createOneShot(
                            ms, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(ms);
                }
            } catch (Exception ignored) {
            }
        }

        private void toast(String msg) {
            final String text = msg;
            runOnUiThread(new Runnable() {
                public void run() {
                    Toast.makeText(MainActivity.this, text, Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
