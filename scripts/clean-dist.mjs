import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "dist");

// 构建前必须删除上一代哈希资源，否则 Service Worker 会把旧 Worker 和主包继续加入预缓存。
// 删除前同时校验父目录和末级目录名，避免未来移动脚本时把错误路径递归删除。
if (dirname(outputDirectory) !== projectRoot || basename(outputDirectory) !== "dist") {
  throw new Error(`拒绝清理非预期目录：${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
