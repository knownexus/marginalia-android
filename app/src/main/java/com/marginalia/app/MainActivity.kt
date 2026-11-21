package com.marginalia.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var repo: DocumentRepository
    private var ready = false
    private val queued = mutableListOf<Pair<String,String>>()
    private fun report(name: String, value: String) {
        if (!ready) { queued.add(name to value); return }
        web.evaluateJavascript("window.MarginaliaNative."+name+"("+JSONObject.quote(value)+")",null)
    }
    private fun perform(action: ()->Unit) { runCatching(action).onFailure { report("status",it.message ?: "File operation failed") } }
    private val pick = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if(uri!=null) perform { report("preview",repo.read(uri)) }
    }
    private val bind = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if(uri!=null) perform { repo.bind(uri); report("status","Library file linked") }
    }
    private val backup = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if(uri!=null) perform { repo.export(uri,repo.current()); report("status","Backup exported") }
    }
    fun fileAction(name:String) = perform {
        when(name) {
            "import" -> pick.launch(arrayOf("*/*"))
            "link" -> bind.launch("marginalia-data.json")
            "export" -> backup.launch("marginalia-backup.json")
            "share" -> {
                val dir=File(cacheDir,"share").apply { mkdirs() }
                val f=File(dir,"marginalia-backup.json").apply {writeText(repo.current())}
                val uri=FileProvider.getUriForFile(this,packageName+".files",f)
                val send=Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                startActivity(Intent.createChooser(send,"Share library backup"))
            }
        }
    }
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repo=DocumentRepository(this)
        web=WebView(this)
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        web.settings.apply {
            javaScriptEnabled=true
            domStorageEnabled=true
            allowFileAccess=false
            allowContentAccess=false
            blockNetworkLoads=true
        }
        web.webChromeClient=WebChromeClient()
        web.webViewClient=object: WebViewClient(){
            override fun onPageFinished(view:WebView,url:String) {
                ready=true
                queued.toList().also { queued.clear() }.forEach { report(it.first,it.second) }
            }
            override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest):Boolean =
                request.url.toString().substringBefore('#')!="file:///android_asset/index.html"
        }
        web.addJavascriptInterface(MarginaliaBridge(this,repo),"MarginaliaAndroid")
        web.setOnApplyWindowInsetsListener { v,i -> v.setPadding(i.systemWindowInsetLeft,i.systemWindowInsetTop,i.systemWindowInsetRight,i.systemWindowInsetBottom);i }
        setContentView(web)
        web.loadUrl("file:///android_asset/index.html")
    }
    @Deprecated("Activity back")
    override fun onBackPressed() {
        web.evaluateJavascript("window.marginaliaBack && window.marginaliaBack()"){if(it!="true") super.onBackPressed()}
    }
}
