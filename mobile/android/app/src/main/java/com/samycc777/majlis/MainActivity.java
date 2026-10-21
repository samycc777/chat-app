package com.samycc777.majlis;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins must be registered before the bridge starts, so the call screen can find them.
        registerPlugin(ScreenSharePlugin.class);
        registerPlugin(CallPlugin.class);
        registerPlugin(PushSetupPlugin.class);
        registerPlugin(BoardPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Also called once the bridge has started, with the intent that opened the app: an app opened
    // from a tapped invite link shows that room instead of the start page it has only begun to load.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openLink(intent);
    }

    // The site keeps the invite from the link and moves the phone to its room, as in a browser.
    private void openLink(Intent intent) {
        if (bridge == null || intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri link = intent.getData();
        Uri site = Uri.parse(bridge.getAppUrl());
        if (link == null || !"https".equals(link.getScheme()) || link.getHost() == null || !link.getHost().equals(site.getHost())) return;
        bridge.getWebView().loadUrl(link.toString());
    }
}
