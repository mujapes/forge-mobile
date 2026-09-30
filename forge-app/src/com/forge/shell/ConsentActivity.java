package com.forge.shell;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/**
 * A window with nothing in it, existing only because createScreenCaptureIntent() must be
 * started for a result from an Activity -- a Service cannot ask. Launched from the
 * notification's Arm action, it collects consent, hands it to ForgeService and finishes, so
 * the user sees the system dialog and then their own screen again.
 */
public class ConsentActivity extends Activity {

    private static final int REQ = 7001;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Intent consent = ScreenGrabber.consentIntent(this);
        if (consent == null) {
            Toast.makeText(this, "Screen capture unavailable", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        try {
            startActivityForResult(consent, REQ);
        } catch (Throwable t) {
            Toast.makeText(this, "Screen capture unavailable", Toast.LENGTH_SHORT).show();
            finish();
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ && result == RESULT_OK && data != null) {
            // The projection itself is started inside the service: it must begin only once
            // the service is foregrounded with the mediaProjection type, which is a
            // requirement from Android 14 and throws otherwise.
            Intent go = new Intent(this, ForgeService.class)
                    .setAction(ForgeService.ACTION_ARM)
                    .putExtra(ForgeService.EXTRA_RESULT, result)
                    .putExtra(ForgeService.EXTRA_DATA, data);
            startService(go);
        } else {
            Toast.makeText(this, "Capture not armed", Toast.LENGTH_SHORT).show();
        }
        finish();
    }
}
