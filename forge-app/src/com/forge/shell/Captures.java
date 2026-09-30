package com.forge.shell;

import android.graphics.Bitmap;
import android.os.Environment;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Where a capture lands, and in what form.
 *
 * Nothing is uploaded. The guest VM mounts this same shared storage, so writing a file here
 * makes it readable by Claude with no transfer at all -- the pattern the screenshot picker
 * already uses ("Claude's Read tool takes a path").
 *
 * A capture is a PAIR of files sharing one stem:
 *   cap-<stamp>.txt   the accessibility tree, or the event log of a recording
 *   cap-<stamp>.jpg   a deliberately tiny image
 *
 * The split is the whole point. Text carries exact strings, exact pixel bounds and exact
 * interaction events, and costs almost nothing to read. The image carries what text cannot:
 * colour, shape, and the overall pattern of the screen. Sending one without the other loses
 * a requirement -- an image alone cannot be trusted for text or position, and a tree alone
 * is blind to anything custom-drawn.
 *
 * The image is small on purpose. Claude bills an image by its pixel dimensions (about
 * width*height/750 tokens), so a full 1080x2400 frame is ~3400 tokens. Downscaled to 300px
 * wide it is ~230, which still reads colour, layout and shape perfectly well -- and the text
 * that would have been lost to downscaling is in the .txt, exactly, where it is cheaper
 * anyway.
 */
public final class Captures {

    /** Chosen so colour and layout survive but the token cost does not. */
    public static final int IMAGE_WIDTH = 300;
    private static final int JPEG_QUALITY = 55;
    private static final int KEEP = 40;

    private Captures() {
    }

    /** /sdcard/Download/forge/captures -- the VM sees this as /mnt/shared/Download/... */
    public static File dir() {
        File base = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_DOWNLOADS), "forge/captures");
        if (!base.exists()) base.mkdirs();
        return base;
    }

    public static String stamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
    }

    /** Write the text half. Returns the file, or null if it could not be written. */
    public static File writeText(String stem, String body) {
        File f = new File(dir(), stem + ".txt");
        OutputStreamWriter w = null;
        try {
            w = new OutputStreamWriter(new FileOutputStream(f), "UTF-8");
            w.write(body);
            w.flush();
            return f;
        } catch (Throwable t) {
            return null;
        } finally {
            closeQuietly(w);
        }
    }

    /** Write the image half, downscaled. Returns the file, or null. */
    public static File writeImage(String stem, Bitmap full) {
        if (full == null) return null;
        File f = new File(dir(), stem + ".jpg");
        FileOutputStream out = null;
        Bitmap small = null;
        try {
            int w = full.getWidth();
            int h = full.getHeight();
            if (w <= 0 || h <= 0) return null;
            int tw = Math.min(IMAGE_WIDTH, w);
            int th = Math.max(1, (int) ((long) h * tw / w));
            small = Bitmap.createScaledBitmap(full, tw, th, true);
            out = new FileOutputStream(f);
            small.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
            out.flush();
            return f;
        } catch (Throwable t) {
            return null;
        } finally {
            closeQuietly(out);
            if (small != null && small != full) small.recycle();
        }
    }

    /**
     * Keep the directory from growing without bound. Captures are cheap to take and easy to
     * forget, and this device is short on storage.
     */
    public static void prune() {
        try {
            File[] files = dir().listFiles();
            if (files == null || files.length <= KEEP * 2) return;
            // Sort newest first by mtime, then delete past the cutoff. Pairs share a stem and
            // a timestamp, so they sort adjacently and are dropped together.
            java.util.Arrays.sort(files, new java.util.Comparator<File>() {
                public int compare(File a, File b) {
                    long d = b.lastModified() - a.lastModified();
                    return d < 0 ? -1 : (d > 0 ? 1 : 0);
                }
            });
            for (int i = KEEP * 2; i < files.length; i++) files[i].delete();
        } catch (Throwable ignored) {
        }
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Throwable ignored) {
        }
    }
}
