package local.acgnhub.mobile

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    // Tauri's AppPlugin consumes WebView history before calling this fallback.
    // Keep the root Activity alive instead of terminating its Rust event loop
    // while WebView/network worker threads are still running.
    if (isTaskRoot) moveTaskToBack(true) else super.onBackPressed()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
