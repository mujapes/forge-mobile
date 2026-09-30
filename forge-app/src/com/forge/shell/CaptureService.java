package com.forge.shell;

import android.accessibilityservice.AccessibilityButtonController;
import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Build;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * The semantic half of a capture.
 *
 * A screenshot is a picture of the screen; this is the screen's structure. For every visible
 * node it reports the class, the text, the state and -- the part no image gives -- the exact
 * bounds in screen pixels. Claude reading "Button "Send" (972,1810)-(1044,1882) click" knows
 * precisely where that control is, instead of estimating from pixels and being wrong about
 * text it had to read out of a JPEG.
 *
 * It is deliberately NOT the whole capture. Custom-drawn views (charts, canvases, images,
 * anything a game draws) are opaque single nodes here, and nothing in the tree carries a
 * colour. That is why a capture also writes a small image: the tree gives exact strings and
 * geometry, the image gives colour, shape and pattern. Neither alone is sufficient.
 */
public class CaptureService extends AccessibilityService {

    /** The running instance, so ForgeService can ask for a snapshot when a button is tapped. */
    private static CaptureService instance;

    private static final int MAX_NODES = 400;
    private static final int MAX_DEPTH = 24;
    /** Content-changed fires in bursts while a list settles; one line per burst is enough. */
    private static final long CONTENT_QUIET_MS = 400L;

    private boolean recording;
    private long startedAt;
    private long lastContentAt;
    private StringBuilder log;
    /** The stem a recording writes under, fixed at start so its thumbnail can be taken then. */
    private String recStem;

    public static CaptureService get() {
        return instance;
    }

    public static boolean isRunning() {
        return instance != null;
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        registerButton();
    }

    /**
     * Claim the accessibility button -- the one in the navigation bar that the "Forge
     * shortcut" toggle turns on.
     *
     * Reaching a capture through the notification shade means pulling the shade down over
     * the very screen being captured, which is both slow and changes what is on it. This
     * button is one tap from anywhere and covers nothing.
     *
     * Requesting it takes TWO things and it silently does nothing with only one: the
     * flagRequestAccessibilityButton flag in capture_service.xml, and a registered callback
     * here. The first shipped without the second, which is exactly why the shortcut toggle
     * appeared in Settings, turned on happily, and then did nothing at all when tapped.
     */
    private void registerButton() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            AccessibilityButtonController c = getAccessibilityButtonController();
            if (c == null) return;
            c.registerAccessibilityButtonCallback(
                    new AccessibilityButtonController.AccessibilityButtonCallback() {
                        @Override
                        public void onClicked(AccessibilityButtonController controller) {
                            onButtonTapped();
                        }
                    });
        } catch (Throwable ignored) {
            // An unavailable button is a missing convenience, never a reason to fail to start.
        }
    }

    /**
     * What the button does depends on what is already happening, so that it is always "the
     * obvious next thing": stop the recording if one is running, otherwise take a shot.
     * The status bar icon shows which of the two it currently means.
     */
    private void onButtonTapped() {
        Intent i = new Intent(this, ForgeService.class)
                .setAction(isRecording() ? ForgeService.ACTION_REC : ForgeService.ACTION_SHOT);
        try {
            startService(i);
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public void onInterrupt() {
    }

    // ---------------------------------------------------------------- recording

    public synchronized void startRecording(String stem) {
        recording = true;
        recStem = stem;
        startedAt = System.currentTimeMillis();
        lastContentAt = 0L;
        log = new StringBuilder();
        log.append("# events (t = seconds since record started)\n");
    }

    public synchronized String stopRecording() {
        recording = false;
        String out = (log == null) ? "" : log.toString();
        log = null;
        return out;
    }

    public synchronized boolean isRecording() {
        return recording;
    }

    public synchronized String recStem() {
        return recStem;
    }

    /** When the current recording began, for the notification's elapsed-time counter. */
    public synchronized long recStartedAt() {
        return startedAt;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        synchronized (this) {
            if (!recording || log == null) return;
            if (log.length() > 60000) return;     // a long session must not grow unbounded

            int type = event.getEventType();
            String kind = kindOf(type);
            if (kind == null) return;

            long now = System.currentTimeMillis();
            if (type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
                if (now - lastContentAt < CONTENT_QUIET_MS) return;
                lastContentAt = now;
            }

            log.append(String.format("t=%.2f %s", (now - startedAt) / 1000.0, kind));
            CharSequence cls = event.getClassName();
            if (!TextUtils.isEmpty(cls)) log.append(' ').append(shortClass(cls.toString()));

            String text = firstText(event);
            if (text != null) log.append(" \"").append(clip(text, 80)).append('"');

            AccessibilityNodeInfo src = event.getSource();
            if (src != null) {
                Rect r = new Rect();
                src.getBoundsInScreen(r);
                if (r.width() > 0 && r.height() > 0) {
                    log.append(String.format(" (%d,%d)", r.left, r.top));
                }
                String id = viewId(src);
                if (id != null) log.append(" #").append(id);
                src.recycle();
            }
            log.append('\n');
        }
    }

    private static String kindOf(int type) {
        switch (type) {
            case AccessibilityEvent.TYPE_VIEW_CLICKED:        return "CLICK";
            case AccessibilityEvent.TYPE_VIEW_LONG_CLICKED:   return "LONGCLICK";
            case AccessibilityEvent.TYPE_VIEW_SCROLLED:       return "SCROLL";
            case AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED:   return "TEXT";
            case AccessibilityEvent.TYPE_VIEW_FOCUSED:        return "FOCUS";
            case AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED: return "WINDOW";
            case AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED: return "CONTENT";
            case AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED: return "NOTIF";
            default: return null;
        }
    }

    private static String firstText(AccessibilityEvent event) {
        if (event.getText() != null) {
            for (int i = 0; i < event.getText().size(); i++) {
                CharSequence c = event.getText().get(i);
                if (!TextUtils.isEmpty(c)) return c.toString();
            }
        }
        CharSequence d = event.getContentDescription();
        return TextUtils.isEmpty(d) ? null : d.toString();
    }

    // ---------------------------------------------------------------- tree snapshot

    /** The visible node tree of the foreground window, as compact text. */
    public String snapshot() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        StringBuilder sb = new StringBuilder();
        if (root == null) {
            sb.append("# no active window (is the accessibility service enabled?)\n");
            return sb.toString();
        }
        CharSequence pkg = root.getPackageName();
        Rect screen = new Rect();
        root.getBoundsInScreen(screen);
        sb.append("# tree pkg=").append(pkg == null ? "?" : pkg)
          .append(" screen=").append(screen.width()).append('x').append(screen.height())
          .append('\n');
        int[] budget = new int[] { MAX_NODES };
        walk(root, 0, sb, budget);
        if (budget[0] <= 0) sb.append("... truncated at ").append(MAX_NODES).append(" nodes\n");
        root.recycle();
        return sb.toString();
    }

    private void walk(AccessibilityNodeInfo node, int depth, StringBuilder sb, int[] budget) {
        if (node == null || budget[0] <= 0 || depth > MAX_DEPTH) return;

        Rect r = new Rect();
        node.getBoundsInScreen(r);
        // Off-screen and zero-area nodes are the bulk of a real tree and describe nothing
        // that is actually in front of the user.
        boolean onScreen = r.width() > 0 && r.height() > 0 && node.isVisibleToUser();

        if (onScreen) {
            String line = describe(node, r);
            if (line != null) {
                budget[0]--;
                for (int i = 0; i < depth && i < 12; i++) sb.append(' ');
                sb.append(line).append('\n');
            }
        }

        int n = node.getChildCount();
        for (int i = 0; i < n && budget[0] > 0; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            // A node that contributes no line of its own must not cost a level of indent,
            // or deep layout wrappers push everything off to the right for no information.
            walk(child, onScreen ? depth + 1 : depth, sb, budget);
            child.recycle();
        }
    }

    /** One line for one node, or null if it says nothing worth a line. */
    private static String describe(AccessibilityNodeInfo node, Rect r) {
        String text = null;
        if (!TextUtils.isEmpty(node.getText())) text = node.getText().toString();
        else if (!TextUtils.isEmpty(node.getContentDescription())) {
            text = node.getContentDescription().toString();
        }
        String id = viewId(node);
        boolean interactive = node.isClickable() || node.isCheckable() || node.isEditable()
                || node.isScrollable() || node.isLongClickable();

        // A layout container with no text, no id and no behaviour is pure structure. Its
        // children are still walked, so dropping the line loses nothing.
        if (text == null && id == null && !interactive) return null;

        StringBuilder b = new StringBuilder();
        CharSequence cls = node.getClassName();
        b.append(cls == null ? "View" : shortClass(cls.toString()));
        if (text != null) b.append(" \"").append(clip(text, 120)).append('"');
        if (id != null) b.append(" #").append(id);
        b.append(String.format(" (%d,%d)-(%d,%d)", r.left, r.top, r.right, r.bottom));

        if (node.isClickable()) b.append(" click");
        if (node.isLongClickable()) b.append(" long");
        if (node.isScrollable()) b.append(" scroll");
        if (node.isEditable()) b.append(" edit");
        if (node.isCheckable()) b.append(node.isChecked() ? " checked" : " unchecked");
        if (node.isSelected()) b.append(" selected");
        if (node.isFocused()) b.append(" focused");
        if (!node.isEnabled()) b.append(" disabled");
        return b.toString();
    }

    private static String viewId(AccessibilityNodeInfo node) {
        String full;
        try {
            full = node.getViewIdResourceName();
        } catch (Throwable t) {
            return null;
        }
        if (TextUtils.isEmpty(full)) return null;
        int slash = full.indexOf('/');
        return slash >= 0 ? full.substring(slash + 1) : full;
    }

    private static String shortClass(String cls) {
        int dot = cls.lastIndexOf('.');
        return dot >= 0 ? cls.substring(dot + 1) : cls;
    }

    private static String clip(String s, int max) {
        String one = s.replace('\n', ' ').replace('"', '\'').trim();
        return one.length() <= max ? one : one.substring(0, max) + "…";
    }
}
