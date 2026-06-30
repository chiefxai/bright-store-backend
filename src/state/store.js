import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

export function readAll(name, fallback = []) {
  const f = file(name);
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  return JSON.parse(fs.readFileSync(f, "utf-8"));
}

export function writeAll(name, data) {
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2));
  return data;
}

export function append(name, item) {
  const arr = readAll(name, []);
  arr.unshift(item);
  writeAll(name, arr);
  return item;
}

export function update(name, id, patch) {
  const arr = readAll(name, []);
  const idx = arr.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  arr[idx] = { ...arr[idx], ...patch };
  writeAll(name, arr);
  return arr[idx];
}
