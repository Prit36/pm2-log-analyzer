/* @ts-self-types="./pm2_core.d.ts" */

/**
 * Opaque engine handle for JS.
 */
export class Pm2Engine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Pm2EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pm2engine_free(ptr, 0);
    }
    /**
     * Start shard ownership [start, end) within file_size.
     * @param {number} start
     * @param {number} end
     * @param {number} file_size
     */
    begin_shard(start, end, file_size) {
        wasm.pm2engine_begin_shard(this.__wbg_ptr, start, end, file_size);
    }
    clear() {
        wasm.pm2engine_clear(this.__wbg_ptr);
    }
    /**
     * @returns {Uint8Array}
     */
    cron_wire() {
        const ret = wasm.pm2engine_cron_wire(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Finish shard (flush carry). Call after all feeds.
     */
    end_shard() {
        wasm.pm2engine_end_shard(this.__wbg_ptr);
    }
    /**
     * Lazily build normalize map for one mode (0/1/2). Prefer this over finalize_paths.
     * @param {number} mode
     */
    ensure_mode(mode) {
        wasm.pm2engine_ensure_mode(this.__wbg_ptr, mode);
    }
    /**
     * Parse `len` bytes previously written at ingest_ptr; `abs_off` is file offset of those bytes.
     * @param {number} len
     * @param {number} abs_off
     * @returns {number}
     */
    feed(len, abs_off) {
        const ret = wasm.pm2engine_feed(this.__wbg_ptr, len, abs_off);
        return ret >>> 0;
    }
    finalize_paths() {
        wasm.pm2engine_finalize_paths(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    hit_count() {
        const ret = wasm.pm2engine_hit_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    hourly_wire() {
        const ret = wasm.pm2engine_hourly_wire(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Grow ingest window to `len` bytes; returns pointer into Wasm memory for JS writes.
     * @param {number} len
     * @returns {number}
     */
    ingest_ptr(len) {
        const ret = wasm.pm2engine_ingest_ptr(this.__wbg_ptr, len);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    methods_mask() {
        const ret = wasm.pm2engine_methods_mask(this.__wbg_ptr);
        return ret;
    }
    constructor() {
        const ret = wasm.pm2engine_new();
        this.__wbg_ptr = ret;
        Pm2EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} mode
     * @param {number} norm_id
     * @returns {Uint8Array | undefined}
     */
    norm_path_bytes(mode, norm_id) {
        const ret = wasm.pm2engine_norm_path_bytes(this.__wbg_ptr, mode, norm_id);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * One-shot parse (copies via wasm-bindgen) — tests / small text only.
     * @param {Uint8Array} buf
     * @param {number} shard_start
     * @param {number} shard_end
     * @param {number} file_size
     * @returns {number}
     */
    parse_shard(buf, shard_start, shard_end, file_size) {
        const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pm2engine_parse_shard(this.__wbg_ptr, ptr0, len0, shard_start, shard_end, file_size);
        return ret >>> 0;
    }
    /**
     * @param {number} path_id
     * @returns {Uint8Array | undefined}
     */
    path_bytes(path_id) {
        const ret = wasm.pm2engine_path_bytes(this.__wbg_ptr, path_id);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {number}
     */
    path_count() {
        const ret = wasm.pm2engine_path_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} normalize_mode
     * @param {number} status_family
     * @param {number} min_ms
     * @param {boolean} need_summary
     * @returns {Uint8Array}
     */
    reaggregate(normalize_mode, status_family, min_ms, need_summary) {
        const ret = wasm.pm2engine_reaggregate(this.__wbg_ptr, normalize_mode, status_family, min_ms, need_summary);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    summary_wire() {
        const ret = wasm.pm2engine_summary_wire(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    unmatched_count() {
        const ret = wasm.pm2engine_unmatched_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    unmatched_sample_wire() {
        const ret = wasm.pm2engine_unmatched_sample_wire(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Pm2Engine.prototype[Symbol.dispose] = Pm2Engine.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./pm2_core_bg.js": import0,
    };
}

const Pm2EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pm2engine_free(ptr, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        throw new Error('pm2_core: pass WebAssembly.Module or bytes (embedded wasm)');
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
