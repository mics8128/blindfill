package io.github.mics8128.blindfill;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Armed by the host over `adb shell am broadcast`; the manifest requires DUMP, so only the shell can send it. */
public class ArmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent i) {
        long ttl = Math.min(Math.max(i.getLongExtra("ttl", 60_000), 1_000), 300_000);
        String mode = i.getStringExtra("mode");
        // labels arrive base64url-encoded so `adb shell` quoting cannot mangle or inject them
        Arm.set(
                i.getStringExtra("token"),
                i.getIntExtra("port", 0),
                "passkey".equals(mode) || "passkey-create".equals(mode) ? mode : "password",
                Arm.unb64(i.getStringExtra("item")),
                Arm.unb64(i.getStringExtra("user")),
                Arm.unb64(i.getStringExtra("rp")),
                ttl);
    }
}
