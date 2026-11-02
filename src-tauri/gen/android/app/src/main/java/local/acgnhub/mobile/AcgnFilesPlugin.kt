package local.acgnhub.mobile

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import androidx.annotation.Keep
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.nio.file.Files
import java.util.Locale

@Keep
@InvokeArg
class ShareFileArgs {
    lateinit var path: String
}

/** Shares only a checked file URI through Android's chooser. No recipient is
 * selected and no file is opened as an executable by this application. */
@Keep
@TauriPlugin
class AcgnFilesPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun share(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareFileArgs::class.java)
            val root = File(activity.filesDir, "Files").canonicalFile
            val source = File(args.path).absoluteFile
            require(source.toPath().none { it.toString() == ".." }) { "导出文件路径无效" }
            val sourcePath = source.toPath().normalize()
            val rootPath = root.toPath()
            require(sourcePath.startsWith(rootPath) && sourcePath != rootPath) {
                "只能导出应用私有下载目录内的文件"
            }
            var checked = rootPath
            for (component in rootPath.relativize(sourcePath)) {
                val name = component.toString()
                require(!name.startsWith(".") && !name.endsWith(".") && !name.endsWith(" ") && name.none { it.isISOControl() }) {
                    "不能导出隐藏目录或下载控制文件"
                }
                checked = checked.resolve(component)
                require(!Files.isSymbolicLink(checked)) { "导出路径不能包含符号链接" }
            }
            require(source.isFile && source.length() > 0L && source.canonicalFile.toPath().startsWith(rootPath)) {
                "请选择已完成的普通文件"
            }
            val extension = source.extension.lowercase(Locale.ROOT)
            require(extension !in setOf("part", "tmp", "aria2", "download")) { "下载尚未完成，不能导出临时文件" }
            val mime = when (extension) {
                "cbz" -> "application/vnd.comicbook+zip"
                "txt" -> "text/plain"
                else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", source)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(source.name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(Intent.createChooser(send, "导出或分享文件"))
                    invoke.resolve()
                } catch (error: Exception) {
                    invoke.reject(error.message ?: "无法打开系统导出选择器")
                }
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "导出文件校验失败")
        }
    }
}
