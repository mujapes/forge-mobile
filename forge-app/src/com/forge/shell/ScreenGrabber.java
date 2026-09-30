package com.forge.shell;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.nio.ByteBuffer;

/**
 * The pixel half of a capture, via MediaProjection.
 *
 * Armed once, then shot many times. That structure is forced by the platform: since Android
 * 14 the consent token returned by createScreenCaptureIntent() is single-use, so a projection
 * started per screenshot would put a system dialog in front of the user on every single tap --
 * which defeats the point of a one-tap button in the notification shade. Instead consent is
 * taken once when capture is armed, the projection and its VirtualDisplay are held open, and
 * each shot is just the latest frame off an ImageReader. The cost is the system's screen-cast
 * indicator showing for as long as capture stays armed; that is the honest trade and the
 * reason arming is explicit rather than automatic.
 */
public final class ScreenGrabber {

    private static MediaProjection projection;
    private static VirtualDisplay display;
    private static ImageReader reader;
    private static int width, height, density;

    private ScreenGrabber() {
    }

    public static boolean isArmed() {
        return projection != null && reader != null;
    }

    /** The consent intent to launch; the result is handed back to arm(). */
    public static Intent consentIntent(Context ctx) {
        MediaProjectionManager m = (MediaProjectionManager)
                ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        return m == null ? null : m.createScreenCaptureIntent();
    }

    /**
     * Turn a granted consent result into a live projection.
     *
     * Must be called only once the service is already in the foreground with the
     * mediaProjection type, or Android 14+ throws when the projection starts.
     */
    public static synchronized boolean arm(Context ctx, int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null) return false;
        disarm();
        try {
            MediaProjectionManager m = (MediaProjectionManager)
                    ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (m == null) return false;
            projection = m.getMediaProjection(resultCode, data);
            if (projection == null) return false;

            // Required from Android 14: a projection without a registered callback throws.
            if (Build.VERSION.SDK_INT >= 34) {
                projection.registerCallback(new MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        disarm();
                    }
                }, new Handler(Looper.getMainLooper()));
            }

            DisplayMetrics dm = new DisplayMetrics();
            WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            wm.getDefaultDisplay().getRealMetrics(dm);
            width = dm.widthPixels;
            height = dm.heightPixels;
            density = dm.densityDpi;

            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            display = projection.createVirtualDisplay("forge-capture",
                    width, height, density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, null);
            return display != null;
        } catch (Throwable t) {
            disarm();
            return false;
        }
    }

    public static synchronized void disarm() {
        try {
            if (display != null) display.release();
        } catch (Throwable ignored) {
        }
        try {
            if (reader != null) reader.close();
        } catch (Throwable ignored) {
        }
        try {
            if (projection != null) projection.stop();
        } catch (Throwable ignored) {
        }
        display = null;
        reader = null;
        projection = null;
    }

    /**
     * The most recent frame, or null.
     *
     * acquireLatestImage drops anything stale, which is what a screenshot wants: the frame
     * as of the tap, not whatever was queued behind it.
     */
    public static synchronized Bitmap grab() {
        if (reader == null) return null;
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return null;
            Image.Plane[] planes = image.getPlanes();
            if (planes == null || planes.length == 0) return null;
            ByteBuffer buf = planes[0].getBuffer();
            int pixelStride = planes[0].getPixelStride();
            int rowStride = planes[0].getRowStride();
            // Each row is padded out to rowStride bytes, so the backing bitmap is wider than
            // the display and must be cropped back. Ignoring this is the classic way to get
            // a skewed image with a diagonal tear.
            int rowPadding = rowStride - pixelStride * width;
            int padded = width + rowPadding / Math.max(1, pixelStride);

            Bitmap full = Bitmap.createBitmap(padded, height, Bitmap.Config.ARGB_8888);
            full.copyPixelsFromBuffer(buf);
            if (padded == width) return full;
            Bitmap cropped = Bitmap.createBitmap(full, 0, 0, width, height);
            full.recycle();
            return cropped;
        } catch (Throwable t) {
            return null;
        } finally {
            if (image != null) {
                try {
                    image.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }
}
