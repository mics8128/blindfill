package io.github.mics8128.blindfill.testrp;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Fake sign-up form: username, new password and confirmation. Shows only the password's SHA-256. */
public class SignupActivity extends Activity {

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(android.view.Window.FEATURE_NO_TITLE);
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(48, 160, 48, 48);
        EditText user = new EditText(this);
        user.setHint("new username");
        user.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        user.setAutofillHints(View.AUTOFILL_HINT_USERNAME);
        user.setContentDescription("new username");
        EditText pw = password("new password");
        EditText confirm = password("confirm password");
        Button create = new Button(this);
        create.setText("create account");
        TextView status = new TextView(this);
        status.setContentDescription("status");
        status.setText("signup ready");
        l.addView(user);
        l.addView(pw);
        l.addView(confirm);
        l.addView(create);
        l.addView(status);
        setContentView(l);
        create.setOnClickListener(v -> {
            String p = pw.getText().toString();
            status.setText("signup user=" + user.getText() + " pwsha256=" + MainActivity.sha256hex(p)
                    + " match=" + p.equals(confirm.getText().toString()));
        });
    }

    private EditText password(String label) {
        EditText e = new EditText(this);
        e.setHint(label);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        e.setAutofillHints("newPassword"); // androidx HintConstants.AUTOFILL_HINT_NEW_PASSWORD
        e.setContentDescription(label);
        return e;
    }
}
