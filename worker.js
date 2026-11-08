"use strict";

const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
let enginePromise = null;
let pyodide = null;
let queue = Promise.resolve();

function progress(message) {
  self.postMessage({ type: "progress", message });
}

function plainJSON(value) {
  return JSON.stringify(value);
}

async function readAsset(path) {
  // no-cache: revalidate so a redeploy never runs stale Python modules.
  const response = await fetch(new URL(`./py/${path}`, self.location.href), { cache: "no-cache" });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Python 소스를 읽지 못했습니다: ${path} (${response.status})`);
  }
  const source = await response.text();
  if (/^\s*<!doctype html/i.test(source) || /^\s*<html/i.test(source)) {
    throw new Error(`Python 소스 대신 HTML이 반환되었습니다: ${path}`);
  }
  return source;
}

async function initialize() {
  progress("Python 실행 환경을 불러옵니다.");
  importScripts(`${PYODIDE_BASE}pyodide.js`);
  pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });

  progress("numpy · shapely · micropip을 불러옵니다.");
  await pyodide.loadPackage(["numpy", "shapely", "micropip"]);

  progress("DXF 라이브러리를 불러옵니다.");
  await pyodide.runPythonAsync(`
import micropip
await micropip.install("ezdxf")
`);

  pyodide.FS.mkdirTree("/sitecode");
  pyodide.FS.writeFile("/sitecode/__init__.py", "", { encoding: "utf8" });

  await pyodide.runPythonAsync(`
import ast
import dataclasses
import importlib
import importlib.util
import json
import math
import sys

sys.path.insert(0, "/sitecode")
sys.path.insert(0, "/")

def _sl_imports(source, package):
    names = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = importlib.util.resolve_name(
                    "." * node.level + (node.module or ""), package
                )
            else:
                base = node.module or ""
            if base:
                names.add(base)
                for alias in node.names:
                    if alias.name != "*":
                        names.add(base + "." + alias.name)
    return sorted(names)

def _sl_installed_root(name):
    if name in sys.stdlib_module_names or name in sys.builtin_module_names:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        return False

def _sl_json_default(value):
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "item"):
        return value.item()
    raise TypeError("JSON으로 변환할 수 없는 Python 결과: " + type(value).__name__)

_sl_project = None
`);

  // Discover same-origin Python dependencies from static import statements.
  // Supports api.py, sibling modules and ordinary package __init__.py files.
  // Dynamic imports or non-Python data assets require an explicit asset contract.
  const visited = new Set();
  const plainModules = new Set();
  const installedRoots = new Map();

  async function installed(root) {
    if (!installedRoots.has(root)) {
      pyodide.globals.set("_sl_root", root);
      installedRoots.set(root, Boolean(pyodide.runPython(
        "_sl_installed_root(_sl_root)"
      )));
    }
    return installedRoots.get(root);
  }

  async function loadModule(importName, required = false) {
    let name = importName;
    const local = name === "sitecode" || name.startsWith("sitecode.");
    if (name === "sitecode") return;
    if (local) name = name.slice("sitecode.".length);
    if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(name)) return;

    const root = name.split(".")[0];
    if (!local && name !== "api" && await installed(root)) return;
    if (visited.has(name)) return;
    visited.add(name);

    const parts = name.split(".");
    if (parts.length > 1) {
      const parent = parts.slice(0, -1).join(".");
      await loadModule((local ? "sitecode." : "") + parent);
      // "from slicing import f" yields candidate "slicing.f"; a plain module
      // (slicing.py) has no submodules, so don't probe the server for them.
      if (plainModules.has(parent)) return;
    }

    const stem = parts.join("/");
    let filename = `${stem}.py`;
    let source = await readAsset(filename);
    let isPackage = false;

    if (source === null) {
      filename = `${stem}/__init__.py`;
      source = await readAsset(filename);
      isPackage = source !== null;
    }
    if (source === null) {
      if (required) throw new Error(`필수 Python 파일이 없습니다: py/${stem}.py`);
      // "from module import function" also produces module.function candidates.
      // Missing candidates are resolved by Python when importing the real module.
      return;
    }

    if (!isPackage) plainModules.add(name);
    progress(`Python 모듈을 준비합니다: ${filename}`);
    const target = `/sitecode/${filename}`;
    pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
    pyodide.FS.writeFile(target, source, { encoding: "utf8" });

    const packageName = isPackage
      ? `sitecode.${name}`
      : (parts.length > 1
        ? `sitecode.${parts.slice(0, -1).join(".")}`
        : "sitecode");

    pyodide.globals.set("_sl_source", source);
    pyodide.globals.set("_sl_package", packageName);
    const dependencies = JSON.parse(pyodide.runPython(
      "json.dumps(_sl_imports(_sl_source, _sl_package))"
    ));
    for (const dependency of dependencies) await loadModule(dependency);
  }

  await loadModule("sitecode.api", true);

  await pyodide.runPythonAsync(`
importlib.invalidate_caches()
_sl_api = importlib.import_module("sitecode.api")
for _sl_name in ("from_dxf", "from_geometry", "from_terrain", "sheets"):
    if not callable(getattr(_sl_api, _sl_name, None)):
        raise RuntimeError("py/api.py에 함수가 없습니다: " + _sl_name)
`);
  progress("Python 엔진이 준비되었습니다.");
  return pyodide;
}

async function engine() {
  if (!enginePromise) {
    enginePromise = initialize().catch(error => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

async function execute(cmd, args) {
  const py = await engine();
  if (cmd === "init") return { ready: true };

  if (!["from_dxf", "from_geometry", "from_terrain", "sheets"].includes(cmd)) {
    throw new Error(`지원하지 않는 작업: ${cmd}`);
  }

  let inputProxy = null;
  try {
    if (cmd === "from_dxf") {
      const data = args.data;
      if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
        throw new Error("DXF 입력은 ArrayBuffer 또는 Uint8Array여야 합니다.");
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!bytes.byteLength) throw new Error("DXF 파일이 비어 있습니다.");
      inputProxy = py.toPy(bytes);
      py.globals.set("_sl_bytes", inputProxy);
      py.globals.set("_sl_args", plainJSON({ settings: args.settings }));
    } else {
      py.globals.set("_sl_args", plainJSON(args));
    }
    py.globals.set("_sl_cmd", cmd);

    const serialized = await py.runPythonAsync(`
_sl_a = json.loads(_sl_args)
if _sl_cmd == "from_dxf":
    _sl_next = _sl_api.from_dxf(bytes(_sl_bytes), _sl_a["settings"])
elif _sl_cmd == "from_geometry":
    _sl_next = _sl_api.from_geometry(_sl_a["geom_json"], _sl_a["settings"])
elif _sl_cmd == "from_terrain":
    _sl_next = _sl_api.from_terrain(
        _sl_a["dem"], _sl_a["buildings"], _sl_a["settings"]
    )
elif _sl_cmd == "sheets":
    if _sl_project is None:
        raise RuntimeError("먼저 프로젝트를 생성하세요.")
    _sl_next = _sl_api.sheets(_sl_project, _sl_a.get("style"))

_sl_serialized = json.dumps(
    _sl_next,
    default=_sl_json_default,
    ensure_ascii=False,
    allow_nan=False
)
if _sl_cmd != "sheets":
    _sl_project = _sl_next
_sl_serialized
`);
    return JSON.parse(serialized);
  } finally {
    for (const name of ["_sl_args", "_sl_cmd", "_sl_bytes", "_sl_next", "_sl_serialized"]) {
      if (py.globals.has(name)) py.globals.delete(name);
    }
    inputProxy?.destroy();
  }
}

self.onmessage = event => {
  const message = event.data;
  // Preserve the ID-free {cmd,args} contract by executing requests serially.
  queue = queue.then(async () => {
    try {
      if (!message || typeof message.cmd !== "string") {
        throw new Error("잘못된 Worker 요청입니다.");
      }
      const result = await execute(message.cmd, message.args || {});
      self.postMessage({ ok: true, result });
    } catch (error) {
      self.postMessage({
        ok: false,
        error: error?.message || String(error)
      });
    }
  });
};
