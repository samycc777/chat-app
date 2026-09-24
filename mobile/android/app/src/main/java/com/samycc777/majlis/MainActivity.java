package com.samycc777.majlis;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins must be registered before the bridge starts, so the call screen can find them.
        registerPlugin(ScreenSharePlugin.class);
        registerPlugin(CallPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
