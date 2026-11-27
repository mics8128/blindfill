package io.github.mics8128.blindfill.testrp;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Fake WebView login (or, with extra "signup", sign-up) page. The HTML is loaded with base URL
 * https://blindfill-test.invalid/, so the document's origin is that domain without any network.
 * The page hands the values to a JS bridge, which shows only the password's SHA-256.
 */
public class WebActivity extends Activity {
    static final String BASE = "https://" + MainActivity.RP_ID + "/";
    private TextView status;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(android.view.Window.FEATURE_NO_TITLE);
        boolean signup = getIntent().getBooleanExtra("signup", false);
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(48, 160, 48, 48);
        status = new TextView(this);
        status.setContentDescription("status");
        status.setText(signup ? "web signup ready" : "web ready");
        WebView web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.addJavascriptInterface(this, "rp");
        l.addView(status);
        l.addView(web, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1200));
        setContentView(l);
        String form = signup
                ? "<input id=u name=email type=email autocomplete=username placeholder=email>"
                        + "<input id=p type=password autocomplete=new-password placeholder='new password'>"
                        + "<input id=c type=password autocomplete=new-password placeholder='confirm password'>"
                        + "<button onclick='rp.signup(u.value,p.value,c.value)'>create</button>"
                : "<input id=u name=email type=email autocomplete=username placeholder=email>"
                        + "<input id=p type=password autocomplete=current-password placeholder=password>"
                        + "<button onclick='rp.login(u.value,p.value)'>sign in</button>";
        String page = "<!doctype html><meta name=viewport content='width=device-width'>"
                + "<style>input,button{display:block;font-size:20px;margin:12px 0;width:90%}</style>"
                + "<form onsubmit='return false'>" + form + "</form>";
        // a real https document URL, answered locally: no network (loadDataWithBaseURL reports no web domain to autofill)
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                if (!MainActivity.RP_ID.equals(r.getUrl().getHost())) return null;
                return new WebResourceResponse("text/html", "utf-8",
                        new ByteArrayInputStream(page.getBytes(StandardCharsets.UTF_8)));
            }
        });
        web.loadUrl(BASE);
    }

    @JavascriptInterface
    public void login(String user, String pw) {
        show("web user=" + user + " pwsha256=" + MainActivity.sha256hex(pw));
    }

    @JavascriptInterface
    public void signup(String user, String pw, String confirm) {
        show("web signup user=" + user + " pwsha256=" + MainActivity.sha256hex(pw) + " match=" + pw.equals(confirm));
    }

    private void show(String s) {
        runOnUiThread(() -> status.setText(s));
    }
}
