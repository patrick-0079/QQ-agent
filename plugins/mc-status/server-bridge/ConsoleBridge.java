package com.qqagent.mcbridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.logging.Level;

/**
 * ConsoleBridge —— 把 Minecraft 服务器日志通过 HTTP 暴露给 QQ 机器人（只读）
 *
 * 为什么需要它：RCON 只能执行命令、拿命令响应，**拿不到服务器控制台输出**
 * （Source RCON 协议的硬限制）。想让机器人"看到服务器发生了什么、刚才为什么崩了"，
 * 只能读 logs/latest.log。机器人跑在你自己电脑上，够不着服务器的文件系统，
 * 所以由这个插件在服务器端开一个只读端点，让机器人主动来拉。
 *
 * 设计边界（很重要）：
 *   1. **只提供日志读取**，不提供任何命令执行 —— 这个插件不做 RCON 的替代品，
 *      也不接受任何写操作。命令执行走服务器自己的 RCON。
 *   2. **必须配 token**（config.yml 里 token 为空插件直接拒绝启动）。
 *      这个端点一旦暴露在公网，没有 token 等于把服务器日志（含玩家 IP、聊天）公开。
 *   3. token 走请求头 X-MC-Log-Token，不放 URL 参数 —— URL 会被写进各种访问日志。
 *   4. 只读文件尾部（默认最多 512KB），几百 MB 的 latest.log 也不会拖慢服务器。
 *
 * 依赖：JDK 自带的 com.sun.net.httpserver，不需要任何第三方库。
 */
public class ConsoleBridge extends JavaPlugin {

    private HttpServer server;
    private String token = "";
    private File logFile;
    private int maxBytes = 512 * 1024;
    private int defaultLines = 200;
    private int maxLines = 2000;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        FileConfiguration cfg = getConfig();

        // ⚠️ fail closed：没配 token 就不启动。宁可不可用，也不能无鉴权暴露日志。
        token = String.valueOf(cfg.getString("token", "")).trim();
        if (token.isEmpty()) {
            getLogger().severe("==================================================");
            getLogger().severe("ConsoleBridge 未启动：config.yml 里的 token 是空的。");
            getLogger().severe("这个端点会把服务器日志暴露到网络，必须有 token 才能开。");
            getLogger().severe("请在 plugins/ConsoleBridge/config.yml 里填 token 后重载/重启。");
            getLogger().severe("==================================================");
            setEnabled(false);
            return;
        }

        int port = cfg.getInt("port", 25585);
        String bind = String.valueOf(cfg.getString("bind", "0.0.0.0"));
        maxBytes = cfg.getInt("maxBytes", 512 * 1024);
        defaultLines = cfg.getInt("defaultLines", 200);
        maxLines = cfg.getInt("maxLines", 2000);

        // 日志文件：默认 logs/latest.log（相对服务器根目录）
        String path = String.valueOf(cfg.getString("logFile", "logs/latest.log"));
        logFile = new File(path);
        if (!logFile.isAbsolute()) logFile = new File(getDataFolder().getParentFile().getParentFile(), path);

        try {
            server = HttpServer.create(new InetSocketAddress(bind, port), 0);
        } catch (IOException e) {
            getLogger().log(Level.SEVERE, "ConsoleBridge 端口 " + port + " 监听失败（可能被占用）：" + e.getMessage(), e);
            setEnabled(false);
            return;
        }

        server.createContext("/logs", this::handleLogs);
        server.setExecutor(null);
        server.start();
        getLogger().info("ConsoleBridge 已启动：http://" + bind + ":" + port + "/logs （日志：" + logFile.getAbsolutePath() + "）");
    }

    @Override
    public void onDisable() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    private void handleLogs(HttpExchange ex) {
        try {
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                respond(ex, 405, "只支持 GET");
                return;
            }
            String got = ex.getRequestHeaders().getFirst("X-MC-Log-Token");
            if (!constantTimeEquals(got == null ? "" : got, token)) {
                // 不回显 token，也不说"差几个字符"—— 那是在帮人爆破
                respond(ex, 401, "unauthorized");
                getLogger().warning("ConsoleBridge 拒绝了一次未授权的日志请求，来源：" + ex.getRemoteAddress());
                return;
            }

            int lines = parseIntParam(ex, "lines", defaultLines, maxLines);
            String keyword = String.valueOf(queryParam(ex, "keyword", "")).trim();

            List<String> all;
            try {
                all = tailLines(logFile, lines, maxBytes);
            } catch (IOException e) {
                respond(ex, 500, "读日志失败：" + e.getMessage());
                return;
            }

            if (!keyword.isEmpty()) {
                String kw = keyword.toLowerCase();
                List<String> hit = new ArrayList<>();
                for (String l : all) if (l.toLowerCase().contains(kw)) hit.add(l);
                all = hit;
            }

            StringBuilder sb = new StringBuilder();
            for (String l : all) sb.append(l).append('\n');
            byte[] body = sb.toString().getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
            ex.sendResponseHeaders(200, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        } catch (Exception e) {
            try {
                respond(ex, 500, "内部错误：" + e.getMessage());
            } catch (Exception ignored) { /* 连接已断就没必要再回 */ }
        } finally {
            ex.close();
        }
    }

    /** 读文件尾部若干行。不整文件读入内存 —— latest.log 可能有几百 MB。 */
    static List<String> tailLines(File f, int lines, int maxBytes) throws IOException {
        if (f == null || !f.exists()) throw new IOException("日志文件不存在：" + (f == null ? "(未配置)" : f.getAbsolutePath()));
        if (f.isDirectory()) throw new IOException("填的是目录不是文件：" + f.getAbsolutePath());
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long len = raf.length();
            long start = Math.max(0, len - maxBytes);
            int size = (int) (len - start);
            if (size <= 0) return new ArrayList<>();
            raf.seek(start);
            byte[] buf = new byte[size];
            raf.readFully(buf);
            String text = new String(buf, StandardCharsets.UTF_8);
            List<String> all = new ArrayList<>(Arrays.asList(text.split("\r?\n")));
            // 起点可能切在半个字中间，第一行不完整 —— 丢掉
            if (start > 0 && !all.isEmpty()) all.remove(0);
            // 去掉末尾空行
            while (!all.isEmpty() && all.get(all.size() - 1).isEmpty()) all.remove(all.size() - 1);
            int n = Math.max(1, Math.min(lines, all.size()));
            return new ArrayList<>(all.subList(all.size() - n, all.size()));
        }
    }

    /** 长度不等也要比完再返回，避免通过响应时间逐位猜 token */
    static boolean constantTimeEquals(String a, String b) {
        if (a == null) a = "";
        if (b == null) b = "";
        int diff = a.length() ^ b.length();
        int n = Math.max(a.length(), b.length());
        for (int i = 0; i < n; i++) {
            int ca = i < a.length() ? a.charAt(i) : 0;
            int cb = i < b.length() ? b.charAt(i) : 0;
            diff |= ca ^ cb;
        }
        return diff == 0;
    }

    private static void respond(HttpExchange ex, int code, String msg) throws IOException {
        byte[] body = msg.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
        ex.sendResponseHeaders(code, body.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(body);
        }
    }

    private static String queryParam(HttpExchange ex, String key, String def) {
        String q = ex.getRequestURI().getRawQuery();
        if (q == null) return def;
        for (String pair : q.split("&")) {
            int i = pair.indexOf('=');
            if (i < 0) continue;
            if (key.equals(pair.substring(0, i))) return pair.substring(i + 1);
        }
        return def;
    }

    private static int parseIntParam(HttpExchange ex, String key, int def, int max) {
        String raw = queryParam(ex, key, "");
        int v;
        try {
            v = Integer.parseInt(raw.trim());
        } catch (Exception e) {
            return def;
        }
        return Math.max(1, Math.min(v, max));
    }
}
