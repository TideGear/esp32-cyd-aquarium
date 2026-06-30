package com.aquarium.clock;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Full-screen kiosk activity that hosts the aquarium-clock WebView.
 *
 *  - Keeps the display awake (FLAG_KEEP_SCREEN_ON) so it can run indefinitely.
 *  - Goes fully immersive (status + navigation bars hidden, sticky).
 *  - Locks to landscape and survives configuration changes without reloading.
 *
 * The slow on-screen movement that protects against burn-in is performed inside
 * the page itself (the whole scene drifts within an over-scanned canvas).
 */
public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep the screen on for the life of this window.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Draw behind the system bars / display cutouts where possible.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF000000);
        webView.setKeepScreenOn(true);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.addJavascriptInterface(new ClipBridge(), "AndroidClip");

        webView.setWebViewClient(new WebViewClient());
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        root.addView(webView);
        setContentView(root);

        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enterImmersiveMode();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersiveMode();
    }

    private void enterImmersiveMode() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController c = window.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            View decor = window.getDecorView();
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    /**
     * Clipboard bridge for the settings UI's per-color copy/paste buttons. The
     * WebView's JS Clipboard API is unreliable from a file:// origin, so the page
     * calls these instead. JS-interface methods run off the UI thread, so both
     * hop to the UI thread (paste blocks briefly for the result).
     */
    private class ClipBridge {
        /** Let the page drive the activity orientation so the OS handles up/down
         *  detection (sensorPortrait/sensorLandscape both auto-rotate 180deg). */
        @JavascriptInterface
        public void setOrientation(final String mode) {
            runOnUiThread(new Runnable() {
                public void run() {
                    setRequestedOrientation("portrait".equals(mode)
                            ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                            : ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                }
            });
        }

        @JavascriptInterface
        public void copy(final String text) {
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        android.content.ClipboardManager cm =
                                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                        if (cm != null) {
                            cm.setPrimaryClip(android.content.ClipData.newPlainText("color", text == null ? "" : text));
                        }
                    } catch (Exception e) { /* ignore */ }
                }
            });
        }

        @JavascriptInterface
        public String paste() {
            final String[] out = { "" };
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        android.content.ClipboardManager cm =
                                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null
                                && cm.getPrimaryClip().getItemCount() > 0) {
                            CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                            out[0] = t == null ? "" : t.toString();
                        }
                    } catch (Exception e) { /* ignore */ }
                    latch.countDown();
                }
            });
            try { latch.await(1, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException e) { /* ignore */ }
            return out[0];
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
