//
// A small implementation of a Web Worker that uses pdfium.wasm to render PDF files.
//

/**
 * PDFium WASM module imports
 */
const Pdfium = {
  /**
   * @param {WebAssembly.Exports} wasmExports
   */
  initWith: function (wasmExports) {
    Pdfium.wasmExports = wasmExports;
    Pdfium.memory = Pdfium.wasmExports.memory;
    Pdfium.wasmTable = Pdfium.wasmExports['__indirect_function_table'];
    Pdfium.stackSave = Pdfium.wasmExports['emscripten_stack_get_current'];
    Pdfium.stackRestore = Pdfium.wasmExports['_emscripten_stack_restore'];
    Pdfium.setThrew = Pdfium.wasmExports['setThrew'];
    Pdfium.__emscripten_stack_alloc = wasmExports['_emscripten_stack_alloc'];
  },

  /**
   * @type {WebAssembly.Exports}
   */
  wasmExports: null,
  /**
   * @type {WebAssembly.Memory}
   */
  memory: null,
  /**
   * @type {WebAssembly.Table}
   */
  wasmTable: null,
  /**
   * @type {WebAssembly.Table}
   */
  wasmTableMirror: [],
  /**
   * @type {WeakMap<Function, number>}
   */
  functionsInTableMap: null,
  /**
   * @type {number[]}
   */
  freeTableIndexes: [],
  /**
   * @type {function():number}
   */
  stackSave: null,
  /**
   * @type {function(number):void}
   */
  stackRestore: null,
  /**
   * @type {function(number, number):void}
   */
  setThrew: null,
  /**
   * @type {function(number):number}
   */
  __emscripten_stack_alloc: null,

  /**
   * Invoke a function from the WASM table
   * @param {number} index Function index
   * @param {function(function())} func Function to call
   * @returns {*} Result of the function
   */
  invokeFunc: function (index, func) {
    const sp = Pdfium.stackSave();
    try {
      return func(Pdfium.wasmTable.get(index));
    } catch (e) {
      Pdfium.stackRestore(sp);
      if (e !== e + 0) throw e;
      Pdfium.setThrew(1, 0);
    }
  },

  getCFunc: (ident) => Pdfium.wasmExports['_' + ident],
  writeArrayToMemory: (array, buffer) => HEAP8.set(array, buffer),
  stackAlloc: (sz) => Pdfium.__emscripten_stack_alloc(sz),
  stringToUTF8OnStack: (str) => {
    const size = StringUtils.lengthBytesUTF8(str) + 1;
    const ret = Pdfium.stackAlloc(size);
    StringUtils.stringToUtf8Bytes(str, ret);
    return ret;
  },
  ccall: (ident, returnType, argTypes, args, opts) => {
    const toC = {
      string: (str) => {
        let ret = 0;
        if (str !== null && str !== undefined && str !== 0) {
          ret = Pdfium.stringToUTF8OnStack(str);
        }
        return ret;
      },
      array: (arr) => {
        const ret = Pdfium.stackAlloc(arr.length);
        Pdfium.writeArrayToMemory(arr, ret);
        return ret;
      },
    };
    function convertReturnValue(ret) {
      if (returnType === 'string') return UTF8ToString(ret);
      if (returnType === 'boolean') return Boolean(ret);
      return ret;
    }
    const func = Pdfium.getCFunc(ident);
    const cArgs = [];
    let stack = 0;
    if (args) {
      for (let i = 0; i < args.length; i++) {
        const converter = toC[argTypes[i]];
        if (converter) {
          if (stack === 0) stack = Pdfium.stackSave();
          cArgs[i] = converter(args[i]);
        } else {
          cArgs[i] = args[i];
        }
      }
    }
    let ret = func(...cArgs);
    function onDone(ret) {
      if (stack !== 0) Pdfium.stackRestore(stack);
      return convertReturnValue(ret);
    }
    ret = onDone(ret);
    return ret;
  },
  cwrap: (ident, returnType, argTypes, opts) => {
    const numericArgs = !argTypes || argTypes.every((type) => type === 'number' || type === 'boolean');
    const numericRet = returnType !== 'string';
    if (numericRet && numericArgs && !opts) {
      return Pdfium.getCFunc(ident);
    }
    return (...args) => Pdfium.ccall(ident, returnType, argTypes, args, opts);
  },
  uleb128Encode: (n, target) => {
    if (n < 128) {
      target.push(n);
    } else {
      target.push(n % 128 | 128, n >> 7);
    }
  },
  sigToWasmTypes: (sig) => {
    const typeNames = {
      i: 'i32',
      j: 'i64',
      f: 'f32',
      d: 'f64',
      e: 'externref',
      p: 'i32',
    };
    const type = {
      parameters: [],
      results: sig[0] == 'v' ? [] : [typeNames[sig[0]]],
    };
    for (let i = 1; i < sig.length; ++i) {
      type.parameters.push(typeNames[sig[i]]);
    }
    return type;
  },
  generateFuncType: (sig, target) => {
    const sigRet = sig.slice(0, 1);
    const sigParam = sig.slice(1);
    const typeCodes = { i: 127, p: 127, j: 126, f: 125, d: 124, e: 111 };
    target.push(96);
    Pdfium.uleb128Encode(sigParam.length, target);
    for (let i = 0; i < sigParam.length; ++i) {
      target.push(typeCodes[sigParam[i]]);
    }
    if (sigRet == 'v') {
      target.push(0);
    } else {
      target.push(1, typeCodes[sigRet]);
    }
  },
  convertJsFunctionToWasm: (func, sig) => {
    if (typeof WebAssembly.Function == 'function') {
      return new WebAssembly.Function(Pdfium.sigToWasmTypes(sig), func);
    }
    const typeSectionBody = [1];
    Pdfium.generateFuncType(sig, typeSectionBody);
    const bytes = [0, 97, 115, 109, 1, 0, 0, 0, 1];
    Pdfium.uleb128Encode(typeSectionBody.length, bytes);
    bytes.push(...typeSectionBody);
    bytes.push(2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
    const module = new WebAssembly.Module(new Uint8Array(bytes));
    const instance = new WebAssembly.Instance(module, { e: { f: func } });
    const wrappedFunc = instance.exports['f'];
    return wrappedFunc;
  },
  updateTableMap: (offset, count) => {
    if (Pdfium.functionsInTableMap) {
      for (let i = offset; i < offset + count; i++) {
        const item = Pdfium.wasmTable.get(i);
        if (item) {
          Pdfium.functionsInTableMap.set(item, i);
        }
      }
    }
  },
  getFunctionAddress: (func) => {
    if (!Pdfium.functionsInTableMap) {
      Pdfium.functionsInTableMap = new WeakMap();
      Pdfium.updateTableMap(0, Pdfium.wasmTable.length);
    }
    return Pdfium.functionsInTableMap.get(func) || 0;
  },
  getEmptyTableSlot: () => {
    if (Pdfium.freeTableIndexes.length) return Pdfium.freeTableIndexes.pop();
    try {
      Pdfium.wasmTable.grow(1);
    } catch (err) {
      if (!(err instanceof RangeError)) {
        throw err;
      }
      throw 'Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.';
    }
    return Pdfium.wasmTable.length - 1;
  },
  /**
   * @param {function} func Function to add
   * @param {string} sig Signature of the function
   * @return {number} Function index in the table
   */
  addFunction: (func, sig) => {
    const rtn = Pdfium.getFunctionAddress(func);
    if (rtn) {
      return rtn;
    }
    const ret = Pdfium.getEmptyTableSlot();
    try {
      Pdfium.wasmTable.set(ret, func);
    } catch (err) {
      if (!(err instanceof TypeError)) {
        throw err;
      }
      const wrapped = Pdfium.convertJsFunctionToWasm(func, sig);
      Pdfium.wasmTable.set(ret, wrapped);
    }
    Pdfium.functionsInTableMap.set(func, ret);
    return ret;
  },
  removeFunction: (index) => {
    Pdfium.functionsInTableMap.delete(Pdfium.wasmTable.get(index));
    Pdfium.wasmTable.set(index, null);
    Pdfium.freeTableIndexes.push(index);
  },
};

/**
 * @typedef {Object} FileContext Defines I/O functions for a file
 * @property {number} size File size
 * @property {function(FileDescriptorContext, Uint8Array):number} read read(context, data)
 * @property {function(FileDescriptorContext):void|undefined} close close(context)
 * @property {function(FileDescriptorContext, Uint8Array):number|undefined} write write(context, data)
 * @property {function(FileDescriptorContext):number|undefined} sync sync(context)
 */

/**
 * @typedef {Object} FileDescriptorContext Defines I/O functions for a file descriptor
 * @property {number} size File size
 * @property {function(FileDescriptorContext, Uint8Array):number} read read(context, data)
 * @property {function(FileDescriptorContext):void|undefined} close close(context)
 * @property {function(FileDescriptorContext, Uint8Array):number|undefined} write write(context, data)
 * @property {function(FileDescriptorContext):number|undefined} sync sync(context)
 * @property {string} fileName
 * @property {number} fd
 * @property {number} flags
 * @property {number} mode
 * @property {number} dirfd
 * @property {number} position Current position
 */

/**
 * @typedef {Object} DirectoryContext Defines I/O functions for a directory file descriptor
 * @property {string[]} entries Directory entries (For directories, the name should be terminated with /)
 */

/**
 * @typedef {Object} DirectoryFileDescriptorContext Defines I/O functions for a directory file descriptor
 * @property {string[]} entries Directory entries (For directories, the name should be terminated with /)
 * @property {string} fileName
 * @property {number} fd
 * @property {number} dirfd
 * @property {number} position Current entry index
 */

/**
 * Emulate file system for PDFium
 */
class FileSystemEmulator {
  constructor() {
    /**
     * Filename to I/O functions/data
     * @type {Object<string, FileContext|DirectoryContext>}
     */
    this.fn2context = {};
    /**
     * File descriptor to I/O functions/data
     * @type {Object<number, FileDescriptorContext|DirectoryFileDescriptorContext>}
     */
    this.fd2context = {};
    /**
     * Last assigned file descriptor
     * @type {number}
     */
    this.fdAssignedLast = 1000;
  }

  /**
   * Register file
   * @param {string} fn Filename
   * @param {FileContext|DirectoryContext} context I/O functions/data
   */
  registerFile(fn, context) {
    this.fn2context[fn] = context;
  }

  /**
   * Register file with ArrayBuffer
   * @param {string} fn Filename
   * @param {ArrayBuffer} data File data
   */
  registerFileWithData(fn, data) {
    data = data.buffer != null ? data.buffer : data;
    this.registerFile(fn, {
      size: data.byteLength,
      read: function (context, buffer) {
        try {
          const size = Math.min(buffer.byteLength, data.byteLength - context.position);
          const array = new Uint8Array(data, context.position, size);
          buffer.set(array);
          context.position += array.byteLength;
          return array.length;
        } catch (err) {
          console.error(`read error: ${_error(err)}`);
          return 0;
        }
      },
    });
  }

  /**
   * Unregister file/directory context
   * @param {string} fn Filename
   */
  unregisterFile(fn) {
    delete this.fn2context[fn];
  }

  /**
   * Open a file
   * @param {number} dirfd Directory file descriptor
   * @param {number} fileNamePtr Pointer to buffer that contains filename
   * @param {number} flags File open flags
   * @param {number} mode File open mode
   * @returns {number} File descriptor
   */
  openFile(dirfd, fileNamePtr, flags, mode) {
    const fn = StringUtils.utf8BytesToString(new Uint8Array(Pdfium.memory.buffer, fileNamePtr, 2048));
    const funcs = this.fn2context[fn];
    if (funcs) {
      const fd = ++this.fdAssignedLast;
      this.fd2context[fd] = { ...funcs, fd, flags, mode, dirfd, position: 0 };
      return fd;
    }
    console.error(`openFile: not found: ${dirfd}/${fn}`);
    return -1;
  }

  /**
   * Close a file
   * @param {number} fd File descriptor
   */
  closeFile(fd) {
    const context = this.fd2context[fd];
    context.close?.call(context);
    delete this.fd2context[fd];
    return 0;
  }

  /**
   * Seek to a position in a file
   * @param {number} fd File descriptor
   * @returns {number} New offset
   */
  seek(fd) {
    let offset, whence, newOffset;
    if (arguments.length == 4) {
      // (fd: number, offset: BigInt, whence: number, newOffset: number)
      offset = Number(arguments[1]); // BigInt to Number
      whence = arguments[2];
      newOffset = arguments[3];
    } else if (arguments.length == 5) {
      // (fd: number, offset_low: number, offset_high: number, whence: number, newOffset: number)
      offset = arguments[1]; // offset_low; offset_high is ignored
      whence = arguments[3];
      newOffset = arguments[4];
    } else {
      throw new Error(`seek: invalid arguments count: ${arguments.length}`);
    }

    const context = this.fd2context[fd];
    switch (whence) {
      case 0: // SEEK_SET
        context.position = offset;
        break;
      case 1: // SEEK_CUR
        context.position += offset;
        break;
      case 2: // SEEK_END
        context.position = context.size + offset;
        break;
    }
    const offsetLowHigh = new Uint32Array(Pdfium.memory.buffer, newOffset, 2);
    offsetLowHigh[0] = context.position;
    offsetLowHigh[1] = 0;
    return 0;
  }

  /**
   * fd__write
   * @param {number} fd
   * @param {number} iovs
   * @param {number} iovs_len
   * @param {number} ret_ptr
   */
  write(fd, iovs, iovs_len, ret_ptr) {
    const context = this.fd2context[fd];
    let total = 0;
    for (let i = 0; i < iovs_len; i++) {
      const iov = new Int32Array(Pdfium.memory.buffer, iovs + i * 8, 2);
      const ptr = iov[0];
      const len = iov[1];
      const written = context.write(context, new Uint8Array(Pdfium.memory.buffer, ptr, len));
      total += written;
      if (written < len) break;
    }
    const bytes_written = new Uint32Array(Pdfium.memory.buffer, ret_ptr, 1);
    bytes_written[0] = written;
    return 0;
  }

  /**
   * fd_read
   * @param {number} fd
   * @param {number} iovs
   * @param {number} iovs_len
   * @param {number} ret_ptr
   */
  read(fd, iovs, iovs_len, ret_ptr) {
    /** @type {FileDescriptorContext} */
    const context = this.fd2context[fd];
    let total = 0;
    for (let i = 0; i < iovs_len; i++) {
      const iov = new Int32Array(Pdfium.memory.buffer, iovs + i * 8, 2);
      const ptr = iov[0];
      const len = iov[1];
      const read = context.read(context, new Uint8Array(Pdfium.memory.buffer, ptr, len));
      total += read;
      if (read < len) break;
    }
    const bytes_read = new Uint32Array(Pdfium.memory.buffer, ret_ptr, 1);
    bytes_read[0] = total;
    return 0;
  }

  sync(fd) {
    const context = this.fd2context[fd];
    return context.sync(context);
  }

  /**
   * __syscall_fstat64
   * @param {number} fd
   * @param {number} statbuf
   * @returns {number}
   */
  fstat(fd, statbuf) {
    const context = this.fd2context[fd];
    const buffer = new Int32Array(Pdfium.memory.buffer, statbuf, 92);
    buffer[6] = context.size; // st_size
    buffer[7] = 0;
    return 0;
  }

  /**
   * __syscall_stat64
   * @param {number} pathnamePtr
   * @param {number} statbuf
   * @returns {number}
   */
  stat64(pathnamePtr, statbuf) {
    const fn = StringUtils.utf8BytesToString(new Uint8Array(Pdfium.memory.buffer, pathnamePtr, 2048));
    const funcs = this.fn2context[fn];
    if (funcs) {
      const buffer = new Int32Array(Pdfium.memory.buffer, statbuf, 92);
      buffer[6] = funcs.size; // st_size
      buffer[7] = 0;
      return 0;
    }
    return -1;
  }

  /**
   * __syscall_getdents64
   * @param {number} fd
   * @param {number} dirp struct linux_dirent64
   * @param {number} count
   * @returns {number}
   */
  getdents64(fd, dirp, count) {
    /** @type {DirectoryFileDescriptorContext} */
    const context = this.fd2context[fd];
    const entries = context.entries;
    if (entries == null) return -1; // not a directory
    context.getdents_position = context.getdents_position || 0;
    let written = 0;
    const DT_REG = 8,
      DT_DIR = 4;
    _memset(dirp, 0, count);
    for (; context.position < entries.length; context.position++) {
      const i = context.position;
      let d_type, d_name;
      if (entries[i].endsWith('/')) {
        d_type = DT_DIR;
        d_name = entries[i].substring(0, entries[i].length - 1);
      } else {
        d_type = DT_REG;
        d_name = entries[i];
      }
      const d_nameLength = StringUtils.lengthBytesUTF8(d_name) + 1;
      const size = 8 + 8 + 2 + 1 + d_nameLength;
      if (written + size > count) break;

      const buffer = new Uint8Array(Pdfium.memory.buffer, dirp + written, size);
      // d_off
      const d_off = written + size;
      buffer[8] = d_off & 255;
      buffer[9] = (d_off >> 8) & 255;
      buffer[10] = (d_off >> 16) & 255;
      buffer[11] = (d_off >> 24) & 255;
      // d_reclen
      buffer[16] = size & 255;
      buffer[17] = (size >> 8) & 255;
      // d_type
      buffer[18] = d_type;
      // d_name
      StringUtils.stringToUtf8Bytes(d_name, new Uint8Array(Pdfium.memory.buffer, dirp + written + 19, d_nameLength));
      written = d_off;
    }
    return written;
  }
}

function _error(e) {
  return e.stack ? e.stack.toString() : e.toString();
}

function _notImplemented(name) {
  throw new Error(`${name} is not implemented`);
}

const fileSystem = new FileSystemEmulator();

const emEnv = {
  __assert_fail: function (condition, filename, line, func) {
    throw new Error(`Assertion failed: ${condition} at ${filename}:${line} (${func})`);
  },
  _emscripten_memcpy_js: function (dest, src, num) {
    new Uint8Array(Pdfium.memory.buffer).copyWithin(dest, src, src + num);
  },
  __syscall_openat: fileSystem.openFile.bind(fileSystem),
  __syscall_fstat64: fileSystem.fstat.bind(fileSystem),
  __syscall_ftruncate64: function (fd, zero, zero2, zero3) {
    _notImplemented('__syscall_ftruncate64');
  },
  __syscall_stat64: fileSystem.stat64.bind(fileSystem),
  __syscall_newfstatat: function (dirfd, pathnamePtr, statbuf, flags) {
    _notImplemented('__syscall_newfstatat');
  },
  __syscall_lstat64: function (pathnamePtr, statbuf) {
    _notImplemented('__syscall_lstat64');
  },
  __syscall_fcntl64: function (fd, cmd, arg) {
    _notImplemented('__syscall_fcntl64');
  },
  __syscall_ioctl: function (fd, request, arg) {
    _notImplemented('__syscall_ioctl');
  },
  __syscall_getdents64: fileSystem.getdents64.bind(fileSystem),
  __syscall_unlinkat: function (dirfd, pathnamePtr, flags) {
    _notImplemented('__syscall_unlinkat');
  },
  __syscall_rmdir: function (pathnamePtr) {
    _notImplemented('__syscall_rmdir');
  },
  _abort_js: function (what) {
    throw new Error(what);
  },
  _emscripten_throw_longjmp: function () {
    throw Infinity;
  },
  _gmtime_js: function (time, tmPtr) {
    time = Number(time);
    const date = new Date(time * 1000);
    const tm = new Int32Array(Pdfium.memory.buffer, tmPtr, 9);
    tm[0] = date.getUTCSeconds();
    tm[1] = date.getUTCMinutes();
    tm[2] = date.getUTCHours();
    tm[3] = date.getUTCDate();
    tm[4] = date.getUTCMonth();
    tm[5] = date.getUTCFullYear() - 1900;
    tm[6] = date.getUTCDay();
    tm[7] = 0; // dst
    tm[8] = 0; // gmtoff
  },
  _mmap_js: function (len, prot, flags, fd, offset_low, offset_high, allocated, addr) {
    _notImplemented('_mmap_js');
  },
  _munmap_js: function (addr, len, prot, flags, fd, offset_low, offset_high) {
    _notImplemented('_munmap_js');
  },
  _localtime_js: function (time, tmPtr) {
    time = Number(time);
    const date = new Date(time * 1000);
    const tm = new Int32Array(Pdfium.memory.buffer, tmPtr, 9);
    tm[0] = date.getSeconds();
    tm[1] = date.getMinutes();
    tm[2] = date.getHours();
    tm[3] = date.getDate();
    tm[4] = date.getMonth();
    tm[5] = date.getFullYear() - 1900;
    tm[6] = date.getDay();
    tm[7] = 0; // dst
    tm[8] = 0; // gmtoff
  },
  _tzset_js: function () {},
  emscripten_date_now: function () {
    return Date.now();
  },
  emscripten_errn: function () {
    _notImplemented('emscripten_errn');
  },
  emscripten_resize_heap: function (requestedSizeInBytes) {
    const maxHeapSizeInBytes = 2 * 1024 * 1024 * 1024; // 2GB
    const pageSize = 65536;
    const requestedPageCount = Math.ceil(requestedSizeInBytes / pageSize);
    if (requestedSizeInBytes > maxHeapSizeInBytes) {
      console.error(
        `emscripten_resize_heap: Cannot enlarge memory, asked for ${requestedSizeInBytes} bytes but limit is ${maxHeapSizeInBytes}`
      );
      return false;
    }

    const maxPageCount = maxHeapSizeInBytes / pageSize;
    const oldPageCount = Math.ceil(Pdfium.memory.buffer.byteLength / pageSize);
    // The geometric-growth target can exceed the memory's declared maximum
    // even when the requested allocation itself still fits.
    const newPageCount = Math.min(maxPageCount, Math.max(Math.ceil(oldPageCount * 1.5), requestedPageCount));
    try {
      Pdfium.memory.grow(newPageCount - oldPageCount);
      console.log(`emscripten_resize_heap: ${oldPageCount} => ${newPageCount}`);
      return true;
    } catch (e) {
      console.error(`emscripten_resize_heap: Failed to resize heap: ${_error(e)}`);
      return false;
    }
  },
  exit: function (status) {
    _notImplemented('exit');
  },
  invoke_ii: function (index, a) {
    return Pdfium.invokeFunc(index, function (func) {
      return func(a);
    });
  },
  invoke_iii: function (index, a, b) {
    return Pdfium.invokeFunc(index, function (func) {
      return func(a, b);
    });
  },
  invoke_iiii: function (index, a, b, c) {
    return Pdfium.invokeFunc(index, function (func) {
      return func(a, b, c);
    });
  },
  invoke_iiiii: function (index, a, b, c, d) {
    return Pdfium.invokeFunc(index, function (func) {
      return func(a, b, c, d);
    });
  },
  invoke_v: function (index) {
    return Pdfium.invokeFunc(index, function (func) {
      func();
    });
  },
  invoke_viii: function (index, a, b, c) {
    Pdfium.invokeFunc(index, function (func) {
      func(a, b, c);
    });
  },
  invoke_viiii: function (index, a, b, c, d) {
    Pdfium.invokeFunc(index, function (func) {
      func(a, b, c, d);
    });
  },
  print: function (text) {
    console.log(text);
  },
  printErr: function (text) {
    console.error(text);
  },
};

const wasi = {
  proc_exit: function (code) {
    _notImplemented('proc_exit');
  },
  environ_sizes_get: function (environCount, environBufSize) {
    _notImplemented('environ_sizes_get');
  },
  environ_get: function (environ, environBuf) {
    _notImplemented('environ_get');
  },
  fd_close: fileSystem.closeFile.bind(fileSystem),
  fd_seek: fileSystem.seek.bind(fileSystem),
  fd_write: fileSystem.write.bind(fileSystem),
  fd_read: fileSystem.read.bind(fileSystem),
  fd_sync: fileSystem.sync.bind(fileSystem),
};

/**
 * @param {{url: string, password: string|undefined, useProgressiveLoading: boolean|undefined, headers: Object.<string, string>|undefined, withCredentials: boolean|undefined, progressCallbackId: number|undefined, preferRangeAccess: boolean|undefined}} params
 */
async function loadDocumentFromUrl(params) {
  const url = params.url;
  const password = params.password || '';
  const useProgressiveLoading = params.useProgressiveLoading || false;
  const headers = params.headers || {};
  const withCredentials = params.withCredentials || false;
  const progressCallbackId = params.progressCallbackId;
  const preferRangeAccess = params.preferRangeAccess || false;

  if (preferRangeAccess) {
    const result = await loadDocumentFromUrlWithRangeAccess({
      url,
      password,
      useProgressiveLoading,
      headers,
      withCredentials,
      progressCallbackId,
    });
    if (result) return result;
  }

  const response = await fetch(url, {
    headers: headers,
    mode: 'cors',
    credentials: withCredentials ? 'include' : 'same-origin',
    redirect: 'follow',
  });
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

  // If we have progress callback and a valid content length, use streaming
  if (progressCallbackId && contentLength > 0 && response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedLength += value.length;

      // Send progress callback
      invokeCallback(progressCallbackId, receivedLength, contentLength);
    }

    // Combine chunks into single ArrayBuffer
    const data = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      data.set(chunk, position);
      position += chunk.length;
    }

    return loadDocumentFromData({
      data: data.buffer,
      password,
      useProgressiveLoading,
    });
  } else {
    // No progress callback or content-length, just get the data directly
    return loadDocumentFromData({
      data: await response.arrayBuffer(),
      password,
      useProgressiveLoading,
    });
  }
}

/**
 * @typedef {{offset: number, end: number}} ByteRange
 */

const PDF_RANGE_DOWNLOAD_BLOCK_SIZE = 64 * 1024;

class PdfRangeCache {
  /**
   * @param {string} url
   * @param {Object.<string, string>} headers
   * @param {boolean} withCredentials
   * @param {number|undefined} progressCallbackId
   */
  constructor(url, headers, withCredentials, progressCallbackId) {
    this.url = url;
    this.headers = headers;
    this.withCredentials = withCredentials;
    this.progressCallbackId = progressCallbackId;
    this.fileSize = 0;
    /** @type {ByteRange[]} */
    this.ranges = [];
    /** @type {{offset: number, data: Uint8Array}[]} */
    this.chunks = [];
    this.bytesCached = 0;
    this.nextUnhintedBlockOffset = 0;
  }

  /**
   * @param {number} offset
   * @param {number} size
   * @returns {ByteRange|null}
   */
  blockAlignedRange(offset, size) {
    if (offset < 0 || size <= 0) return null;
    if (this.fileSize > 0 && offset >= this.fileSize) return null;

    const end = offset + size;
    const alignedOffset = Math.floor(offset / PDF_RANGE_DOWNLOAD_BLOCK_SIZE) * PDF_RANGE_DOWNLOAD_BLOCK_SIZE;
    let alignedEnd = Math.ceil(end / PDF_RANGE_DOWNLOAD_BLOCK_SIZE) * PDF_RANGE_DOWNLOAD_BLOCK_SIZE;
    if (this.fileSize > 0) {
      alignedEnd = Math.min(alignedEnd, this.fileSize);
    }
    if (alignedEnd <= alignedOffset) return null;

    return { offset: alignedOffset, end: alignedEnd };
  }

  get fetchCredentials() {
    return this.withCredentials ? 'include' : 'same-origin';
  }

  async ensureFileSize() {
    if (this.fileSize > 0) return this.fileSize;
    const response = await fetch(this.url, {
      method: 'HEAD',
      headers: this.headers,
      mode: 'cors',
      credentials: this.fetchCredentials,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`Failed to get PDF file size: ${response.status} ${response.statusText}`);
    }
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (!contentLength) {
      throw new Error('Failed to get PDF file size from Content-Length');
    }
    this.fileSize = contentLength;
    return this.fileSize;
  }

  /**
   * @param {number} offset
   * @param {number} size
   * @returns {boolean}
   */
  isDataAvailable(offset, size) {
    if (size <= 0) return true;
    const end = offset + size;
    for (const range of this.ranges) {
      if (offset >= range.offset && end <= range.end) return true;
      if (range.offset > offset) return false;
    }
    return false;
  }

  /**
   * @param {number} offset
   * @param {number} size
   * @returns {ByteRange[]}
   */
  missingRanges(offset, size) {
    if (size <= 0) return [];
    const end = offset + size;
    let position = offset;
    /** @type {ByteRange[]} */
    const missing = [];

    for (const range of this.ranges) {
      if (range.end <= position) continue;
      if (range.offset >= end) break;
      if (position < range.offset) {
        missing.push({ offset: position, end: Math.min(range.offset, end) });
      }
      position = Math.max(position, range.end);
      if (position >= end) break;
    }

    if (position < end) {
      missing.push({ offset: position, end });
    }
    return missing;
  }

  /**
   * @returns {Promise<ByteRange|null>}
   */
  async nextUnhintedBlock() {
    await this.ensureFileSize();

    const tailOffset = Math.floor((this.fileSize - 1) / PDF_RANGE_DOWNLOAD_BLOCK_SIZE) * PDF_RANGE_DOWNLOAD_BLOCK_SIZE;
    if (!this.isDataAvailable(tailOffset, this.fileSize - tailOffset)) {
      return { offset: tailOffset, end: this.fileSize };
    }

    for (let offset = this.nextUnhintedBlockOffset; offset < this.fileSize; offset += PDF_RANGE_DOWNLOAD_BLOCK_SIZE) {
      const end = Math.min(offset + PDF_RANGE_DOWNLOAD_BLOCK_SIZE, this.fileSize);
      this.nextUnhintedBlockOffset = end;
      if (!this.isDataAvailable(offset, end - offset)) {
        return { offset, end };
      }
    }

    return null;
  }

  /**
   * @param {number} offset
   * @param {Uint8Array} data
   */
  addData(offset, data) {
    if (data.length === 0) return;
    this.chunks.push({ offset, data });
    this._addRange(offset, offset + data.length);
    this.bytesCached = this.ranges.reduce((sum, range) => sum + range.end - range.offset, 0);
    invokeCallback(this.progressCallbackId, this.bytesCached, this.fileSize || undefined);
  }

  /**
   * @param {number} offset
   * @param {number} end
   */
  _addRange(offset, end) {
    const ranges = [...this.ranges, { offset, end }].sort((a, b) => a.offset - b.offset);
    /** @type {ByteRange[]} */
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (!last || range.offset > last.end) {
        merged.push({ offset: range.offset, end: range.end });
      } else {
        last.end = Math.max(last.end, range.end);
      }
    }
    this.ranges = merged;
  }

  /**
   * @param {number} offset
   * @param {number} pBuf
   * @param {number} size
   * @returns {number}
   */
  read(offset, pBuf, size) {
    if (!this.isDataAvailable(offset, size)) return 0;

    const dst = new Uint8Array(Pdfium.memory.buffer, pBuf, size);
    let copied = 0;
    let position = offset;
    while (copied < size) {
      const chunk = this.chunks.find((candidate) => {
        const end = candidate.offset + candidate.data.length;
        return position >= candidate.offset && position < end;
      });
      if (!chunk) return 0;

      const chunkOffset = position - chunk.offset;
      const bytesToCopy = Math.min(size - copied, chunk.data.length - chunkOffset);
      dst.set(chunk.data.subarray(chunkOffset, chunkOffset + bytesToCopy), copied);
      copied += bytesToCopy;
      position += bytesToCopy;
    }
    return 1;
  }

  /**
   * @param {number} offset
   * @param {number} size
   * @returns {Promise<boolean>} true if range access is usable; false if the caller should use full download.
   */
  async download(offset, size) {
    const range = this.blockAlignedRange(offset, size);
    if (!range || this.isDataAvailable(range.offset, range.end - range.offset)) return true;

    const response = await fetch(this.url, {
      headers: {
        ...this.headers,
        Range: `bytes=${range.offset}-${range.end - 1}`,
      },
      mode: 'cors',
      credentials: this.fetchCredentials,
      redirect: 'follow',
    });
    if (response.status === 200) {
      const data = new Uint8Array(await response.arrayBuffer());
      this.fileSize = data.length;
      this.addData(0, data);
      return false;
    }

    if (response.status !== 206) {
      throw new Error(`Failed to download PDF range: ${response.status} ${response.statusText}`);
    }

    const contentRange = response.headers.get('content-range');
    let start = range.offset;
    let total = this.fileSize;
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
    if (match && match[3] !== '*') {
      start = parseInt(match[1], 10);
      total = parseInt(match[3], 10);
    } else {
      total = await this.ensureFileSize();
    }

    const data = new Uint8Array(await response.arrayBuffer());
    this.fileSize = total;
    this.addData(start, data);
    return true;
  }
}

const PDF_DATA_ERROR = -1;
const PDF_DATA_NOTAVAIL = 0;
const PDF_DATA_AVAIL = 1;
const PDF_FORM_ERROR = -1;
const PDF_FORM_NOTAVAIL = 0;
const PDF_FORM_AVAIL = 1;
const PDF_FORM_NOTEXIST = 2;

/** @type {Object<number, {avail: number, cache: PdfRangeCache, downloadHintsPtr: number, takeSegments: function():ByteRange[]}>} */
const rangeDocumentAvailabilities = {};

/**
 * @param {{url: string, password: string, useProgressiveLoading: boolean, headers: Object.<string, string>, withCredentials: boolean, progressCallbackId: number|undefined}} params
 * @returns {Promise<PdfDocument|PdfError|null>} null means range access was not usable and the caller should fall back.
 */
async function loadDocumentFromUrlWithRangeAccess(params) {
  const requiredExports = [
    'FPDFAvail_Create',
    'FPDFAvail_Destroy',
    'FPDFAvail_IsDocAvail',
    'FPDFAvail_GetDocument',
    'FPDFAvail_IsPageAvail',
    'FPDFAvail_IsFormAvail',
  ];
  if (!requiredExports.every((name) => typeof Pdfium.wasmExports[name] === 'function')) {
    return null;
  }

  const cache = new PdfRangeCache(params.url, params.headers, params.withCredentials, params.progressCallbackId);
  const initialRangeSize = 64 * 1024;
  const rangeUsable = await cache.download(0, initialRangeSize);
  if (!rangeUsable || cache.fileSize <= 0) return null;

  const fileAvailSize = 8; // FX_FILEAVAIL: int version + function pointer
  const downloadHintsSize = 8; // FX_DOWNLOADHINTS: int version + function pointer
  const fileAccessSize = 12; // FPDF_FILEACCESS: length + getBlock + param
  let fileAvailPtr = 0;
  let downloadHintsPtr = 0;
  let fileAccessPtr = 0;
  let isDataAvailCallback = 0;
  let addSegmentCallback = 0;
  let getBlockCallback = 0;
  let avail = 0;
  let docHandle = 0;
  let disposed = false;
  /** @type {ByteRange[]} */
  let pendingSegments = [];

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (docHandle) delete rangeDocumentAvailabilities[docHandle];
    if (avail) Pdfium.wasmExports.FPDFAvail_Destroy(avail);
    if (isDataAvailCallback) Pdfium.removeFunction(isDataAvailCallback);
    if (addSegmentCallback) Pdfium.removeFunction(addSegmentCallback);
    if (getBlockCallback) Pdfium.removeFunction(getBlockCallback);
    if (fileAvailPtr) Pdfium.wasmExports.free(fileAvailPtr);
    if (downloadHintsPtr) Pdfium.wasmExports.free(downloadHintsPtr);
    if (fileAccessPtr) Pdfium.wasmExports.free(fileAccessPtr);
  };

  try {
    fileAvailPtr = Pdfium.wasmExports.malloc(fileAvailSize);
    downloadHintsPtr = Pdfium.wasmExports.malloc(downloadHintsSize);
    fileAccessPtr = Pdfium.wasmExports.malloc(fileAccessSize);
    if (!fileAvailPtr || !downloadHintsPtr || !fileAccessPtr) {
      throw new Error('Failed to allocate PDF range access structures');
    }

    isDataAvailCallback = Pdfium.addFunction((_pThis, offset, size) => {
      return cache.isDataAvailable(offset, size) ? 1 : 0;
    }, 'iiii');
    addSegmentCallback = Pdfium.addFunction((_pThis, offset, size) => {
      pendingSegments.push({ offset, end: offset + size });
    }, 'viii');
    getBlockCallback = Pdfium.addFunction((_param, position, pBuf, size) => {
      return cache.read(position, pBuf, size);
    }, 'iiiii');

    const fileAvail = new Uint32Array(Pdfium.memory.buffer, fileAvailPtr, fileAvailSize >> 2);
    fileAvail[0] = 1;
    fileAvail[1] = isDataAvailCallback;

    const downloadHints = new Uint32Array(Pdfium.memory.buffer, downloadHintsPtr, downloadHintsSize >> 2);
    downloadHints[0] = 1;
    downloadHints[1] = addSegmentCallback;

    const fileAccess = new Uint32Array(Pdfium.memory.buffer, fileAccessPtr, fileAccessSize >> 2);
    fileAccess[0] = cache.fileSize;
    fileAccess[1] = getBlockCallback;
    fileAccess[2] = 0;

    avail = Pdfium.wasmExports.FPDFAvail_Create(fileAvailPtr, fileAccessPtr);
    if (!avail) {
      dispose();
      return null;
    }

    const docResult = await _waitForPdfAvailability(cache, () => Pdfium.wasmExports.FPDFAvail_IsDocAvail(avail, downloadHintsPtr), () => {
      const segments = pendingSegments;
      pendingSegments = [];
      return segments;
    });
    if (docResult === PDF_DATA_ERROR) {
      throw new Error('Failed to make PDF document data available');
    }

    const passwordPtr = StringUtils.allocateUTF8(params.password);
    try {
      docHandle = Pdfium.wasmExports.FPDFAvail_GetDocument(avail, passwordPtr);
    } finally {
      StringUtils.freeUTF8(passwordPtr);
    }
    if (!docHandle) {
      dispose();
      return _loadDocument(docHandle, params.useProgressiveLoading, () => {}, params.password);
    }

    const formResult = await _waitForPdfAvailability(
      cache,
      () => Pdfium.wasmExports.FPDFAvail_IsFormAvail(avail, downloadHintsPtr),
      () => {
        const segments = pendingSegments;
        pendingSegments = [];
        return segments;
      },
      [PDF_FORM_AVAIL, PDF_FORM_NOTEXIST],
      PDF_FORM_ERROR
    );
    if (formResult === PDF_FORM_ERROR) {
      throw new Error('Failed to make PDF form data available');
    }

    rangeDocumentAvailabilities[docHandle] = {
      avail,
      cache,
      downloadHintsPtr,
      takeSegments: () => {
        const segments = pendingSegments;
        pendingSegments = [];
        return segments;
      },
    };

    const pageCount = Pdfium.wasmExports.FPDF_GetPageCount(docHandle);
    if (params.useProgressiveLoading) {
      await _ensurePageAvailable(docHandle, 0);
    } else {
      for (let i = 0; i < pageCount; i++) {
        await _ensurePageAvailable(docHandle, i);
      }
    }

    return _loadDocument(docHandle, params.useProgressiveLoading, dispose, params.password);
  } catch (e) {
    if (docHandle) {
      try {
        Pdfium.wasmExports.FPDF_CloseDocument(docHandle);
      } catch (_) {}
    }
    dispose();
    throw e;
  }
}

/**
 * @param {number} docHandle
 * @param {number} pageIndex
 */
async function _ensurePageAvailable(docHandle, pageIndex) {
  const availability = rangeDocumentAvailabilities[docHandle];
  if (!availability) return;

  const result = await _waitForPdfAvailability(
    availability.cache,
    () => Pdfium.wasmExports.FPDFAvail_IsPageAvail(availability.avail, pageIndex, availability.downloadHintsPtr),
    availability.takeSegments
  );
  if (result === PDF_DATA_ERROR) {
    throw new Error(`Failed to make PDF page ${pageIndex} data available`);
  }
}

/**
 * @param {PdfRangeCache} cache
 * @param {function():number} check
 * @param {function():ByteRange[]} takeSegments
 * @param {number[]} availableResults
 * @param {number} errorResult
 * @returns {Promise<number>}
 */
async function _waitForPdfAvailability(
  cache,
  check,
  takeSegments,
  availableResults = [PDF_DATA_AVAIL],
  errorResult = PDF_DATA_ERROR
) {
  for (let i = 0; i < 1000; i++) {
    const result = check();
    const segments = takeSegments();
    if (availableResults.includes(result)) return result;
    if (result === errorResult) return result;
    if (result !== PDF_DATA_NOTAVAIL && result !== PDF_FORM_NOTAVAIL) return result;
    if (segments.length === 0) {
      const segment = await cache.nextUnhintedBlock();
      if (!segment) {
        return availableResults[0];
      }
      const size = segment.end - segment.offset;
      const rangeUsable = await cache.download(segment.offset, size);
      if (!rangeUsable && !cache.isDataAvailable(segment.offset, size)) {
        throw new Error('PDF range response did not expose usable Content-Range metadata');
      }
      continue;
    }
    for (const segment of _mergeDownloadSegments(segments)) {
      for (const missing of cache.missingRanges(segment.offset, segment.end - segment.offset)) {
        const size = missing.end - missing.offset;
        const rangeUsable = await cache.download(missing.offset, size);
        if (!rangeUsable && !cache.isDataAvailable(missing.offset, size)) {
          throw new Error('PDF range response did not expose usable Content-Range metadata');
        }
      }
    }
  }
  throw new Error('Timed out while waiting for PDF range data availability');
}

/**
 * @param {ByteRange[]} segments
 * @returns {ByteRange[]}
 */
function _mergeDownloadSegments(segments) {
  const sorted = segments
    .filter((segment) => segment.end > segment.offset)
    .map((segment) => ({
      offset: Math.floor(segment.offset / PDF_RANGE_DOWNLOAD_BLOCK_SIZE) * PDF_RANGE_DOWNLOAD_BLOCK_SIZE,
      end: Math.ceil(segment.end / PDF_RANGE_DOWNLOAD_BLOCK_SIZE) * PDF_RANGE_DOWNLOAD_BLOCK_SIZE,
    }))
    .sort((a, b) => a.offset - b.offset);
  /** @type {ByteRange[]} */
  const merged = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (!last || segment.offset > last.end) {
      merged.push({ offset: segment.offset, end: segment.end });
    } else {
      last.end = Math.max(last.end, segment.end);
    }
  }
  return merged;
}

let nextDataOpenHandle = 1;
const PDF_ERROR_PASSWORD = 4;
/** @type {Object<number, {data: ArrayBuffer, useProgressiveLoading: boolean|undefined, url: string}>} */
const pendingDataOpens = {};

/**
 * Attempts to open worker-owned bytes. Native/virtual-file allocations are
 * retained only by a successfully opened document.
 * @param {{data: ArrayBuffer, password: string|undefined, useProgressiveLoading: boolean|undefined, url: string}} params
 */
function _tryLoadDocumentFromData(params) {
  const data = params.data;
  const password = params.password || '';
  const useProgressiveLoading = params.useProgressiveLoading;

  const sizeThreshold = 1024 * 1024; // 1MB
  if (data.byteLength < sizeThreshold) {
    const buffer = Pdfium.wasmExports.malloc(data.byteLength);
    if (buffer === 0) {
      throw new Error('Failed to allocate memory for PDF data (${data.byteLength} bytes)');
    }
    new Uint8Array(Pdfium.memory.buffer, buffer, data.byteLength).set(new Uint8Array(data));
    const passwordPtr = StringUtils.allocateUTF8(password);
    const docHandle = Pdfium.wasmExports.FPDF_LoadMemDocument(buffer, data.byteLength, passwordPtr);
    StringUtils.freeUTF8(passwordPtr);
    const result = _loadDocument(docHandle, useProgressiveLoading, () => Pdfium.wasmExports.free(buffer), password);
    if (result.errorCode !== undefined) Pdfium.wasmExports.free(buffer);
    return result;
  }

  const tempFileName = params.url;
  fileSystem.registerFileWithData(tempFileName, data);

  const fileNamePtr = StringUtils.allocateUTF8(tempFileName);
  const passwordPtr = StringUtils.allocateUTF8(password);
  const docHandle = Pdfium.wasmExports.FPDF_LoadDocument(fileNamePtr, passwordPtr);
  StringUtils.freeUTF8(passwordPtr);
  StringUtils.freeUTF8(fileNamePtr);
  const result = _loadDocument(docHandle, useProgressiveLoading, () => fileSystem.unregisterFile(tempFileName), password);
  if (result.errorCode !== undefined) fileSystem.unregisterFile(tempFileName);
  return result;
}

/**
 * @param {{data: ArrayBuffer, password: string|undefined, useProgressiveLoading: boolean|undefined}} params
 */
function loadDocumentFromData(params) {
  const dataHandle = nextDataOpenHandle++;
  const pending = {
    data: params.data,
    useProgressiveLoading: params.useProgressiveLoading,
    url: `/tmp/pdfrx-data-open-${dataHandle}.pdf`,
  };
  const result = _tryLoadDocumentFromData({ ...pending, password: params.password });
  if (result.errorCode === PDF_ERROR_PASSWORD) {
    pendingDataOpens[dataHandle] = pending;
    return { ...result, dataHandle };
  }
  return result;
}

/**
 * @param {{dataHandle: number, password: string}} params
 */
function retryDocumentFromData(params) {
  const pending = pendingDataOpens[params.dataHandle];
  if (!pending) throw new Error(`Unknown pending data-open handle: ${params.dataHandle}`);
  const result = _tryLoadDocumentFromData({ ...pending, password: params.password });
  if (result.errorCode === PDF_ERROR_PASSWORD) {
    return { ...result, dataHandle: params.dataHandle };
  }
  delete pendingDataOpens[params.dataHandle];
  return result;
}

/**
 * @param {{dataHandle: number}} params
 */
function cancelDocumentFromData(params) {
  delete pendingDataOpens[params.dataHandle];
  return {};
}

/** @type {Object<number, function():void>} */
const disposers = {};
/** @type {Object<number, string>} Password used to open each live document. */
const documentPasswords = {};

/** @typedef {{face: string, weight: number, italic: boolean, charset: number, pitch_family: number}} FontQuery
 * @typedef {Object<string, FontQuery>} FontQueries
 */
/** @type {FontQueries} */
let lastMissingFonts = {};

/** @type {Object<number, FontQueries>} */
let missingFonts = {};

/**
 *
 * @param {number} docHandle
 * @returns {FontQueries} Missing fonts new found.
 */
function _updateMissingFonts(docHandle) {
  if (Object.keys(lastMissingFonts).length === 0) return;

  const existing = missingFonts[docHandle] ?? {};
  missingFonts[docHandle] = { ...existing, ...lastMissingFonts };
  const result = lastMissingFonts;
  lastMissingFonts = {};
  return result;
}

function _resetMissingFonts() {
  missingFonts = {};
}

/**
 * @typedef {{docHandle: number,permissions: number, securityHandlerRevision: number, pages: PdfPage[], formHandle: number, formInfo: number, missingFonts: FontQueries}} PdfDocument
 * @typedef {{pageIndex: number, width: number, height: number, rotation: number, isLoaded: boolean, bbLeft: number, bbBottom: number}} PdfPage
 * @typedef {{errorCode: number, errorCodeStr: string|undefined, message: string}} PdfError
 */

// [pdfrx_web: form support — reapplied by scripts/sync-assets.mjs] {
/**
 * Per-form-fill-environment state. Keyed by the `formInfo` pointer, which PDFium
 * hands back to us as `pThis` in every FPDF_FORMFILLINFO callback.
 * @typedef {{
 *   docHandle: number,
 *   formHandle: number,
 *   notifyCallbackId: number,
 *   currentPageHandle: number,
 *   openPages: Map<number, number>,
 *   handleToIndex: Map<number, number>,
 * }} FormContext
 */

/** @type {Object<number, FormContext>} formInfo pointer -> context */
const formContextsByInfo = {};
/** @type {Object<number, number>} docHandle -> formInfo pointer */
const formInfoByDoc = {};
/** Cached FPDF_FORMFILLINFO callback table (created once, shared by all documents). */
let _formFillCallbacks = null;
let _formTimerSeq = 1;

/**
 * @param {number} pThis formInfo pointer passed back by PDFium
 * @returns {FormContext|undefined}
 */
function _formCtxByInfo(pThis) {
  return formContextsByInfo[pThis];
}

/**
 * @param {number} docHandle
 * @returns {FormContext|undefined}
 */
function _formCtxByDoc(docHandle) {
  const info = formInfoByDoc[docHandle];
  return info ? formContextsByInfo[info] : undefined;
}

/**
 * Lazily builds the shared FPDF_FORMFILLINFO callback function pointers. Must run
 * after the wasm module is initialized (so `Pdfium.addFunction` is available).
 * @returns {Object<string, number>} map of slot name -> table index
 */
function _ensureFormFillCallbacks() {
  if (_formFillCallbacks) return _formFillCallbacks;
  const add = (fn, sig) => Pdfium.addFunction(fn, sig);

  _formFillCallbacks = {
    // FFI_Invalidate(pThis, page, double left, top, right, bottom)
    invalidate: add((pThis, page, left, top, right, bottom) => {
      const ctx = _formCtxByInfo(pThis);
      if (!ctx || !ctx.notifyCallbackId) return;
      const pageIndex = ctx.handleToIndex.get(page);
      invokeCallback(ctx.notifyCallbackId, {
        kind: 'invalidate',
        pageIndex: pageIndex ?? -1,
        rect: [left, top, right, bottom],
      });
    }, 'viidddd'),
    // FFI_SetCursor(pThis, nCursorType)
    setCursor: add(() => {}, 'vii'),
    // FFI_SetTimer(pThis, uElapse, lpTimerFunc) -> int id (no real timer -> no caret blink)
    setTimer: add(() => _formTimerSeq++, 'iiii'),
    // FFI_KillTimer(pThis, nTimerID)
    killTimer: add(() => {}, 'vii'),
    // FFI_GetLocalTime(pThis) -> FPDF_SYSTEMTIME (struct return via sret pointer)
    getLocalTime: add((retPtr) => {
      new Uint8Array(Pdfium.memory.buffer, retPtr, 16).fill(0);
    }, 'vii'),
    // FFI_OnChange(pThis)
    onChange: add((pThis) => {
      const ctx = _formCtxByInfo(pThis);
      if (ctx && ctx.notifyCallbackId) invokeCallback(ctx.notifyCallbackId, { kind: 'change' });
    }, 'vi'),
    // FFI_GetPage(pThis, document, nPageIndex) -> FPDF_PAGE
    getPage: add((pThis, _document, nPageIndex) => {
      const ctx = _formCtxByInfo(pThis);
      return ctx ? ctx.openPages.get(nPageIndex) ?? 0 : 0;
    }, 'iiii'),
    // FFI_GetCurrentPage(pThis, document) -> FPDF_PAGE
    getCurrentPage: add((pThis) => {
      const ctx = _formCtxByInfo(pThis);
      return ctx ? ctx.currentPageHandle : 0;
    }, 'iii'),
    // FFI_GetRotation(pThis, page) -> int
    getRotation: add(() => 0, 'iii'),
    // FFI_ExecuteNamedAction(pThis, namedAction)
    executeNamedAction: add(() => {}, 'vii'),
    // FFI_SetTextFieldFocus(pThis, value, valueLen, is_focus)
    setTextFieldFocus: add(() => {}, 'viiii'),
    // FFI_DoURIAction(pThis, bsURI) — viewer owns link navigation
    doURIAction: add(() => {}, 'vii'),
    // FFI_DoGoToAction(pThis, nPageIndex, zoomMode, fPosArray, sizeofArray)
    doGoToAction: add(() => {}, 'viiiii'),
  };
  return _formFillCallbacks;
}

/**
 * Fills the FPDF_FORMFILLINFO struct (version 1) at `formInfo` with our callback
 * pointers and registers the per-document form context.
 * @param {number} formInfo pointer to a 35-int block
 * @param {number} docHandle
 */
function _initFormFillInfo(formInfo, docHandle) {
  const cb = _ensureFormFillCallbacks();
  const u32 = new Uint32Array(Pdfium.memory.buffer, formInfo, 35);
  u32.fill(0); // malloc does not zero; clear reserved/unused slots
  u32[0] = 1; // version
  // u32[1] = Release (null)
  u32[2] = cb.invalidate;
  // u32[3] = FFI_OutputSelectedRect (null)
  u32[4] = cb.setCursor;
  u32[5] = cb.setTimer;
  u32[6] = cb.killTimer;
  u32[7] = cb.getLocalTime;
  u32[8] = cb.onChange;
  u32[9] = cb.getPage;
  u32[10] = cb.getCurrentPage;
  u32[11] = cb.getRotation;
  u32[12] = cb.executeNamedAction;
  u32[13] = cb.setTextFieldFocus;
  u32[14] = cb.doURIAction;
  u32[15] = cb.doGoToAction;
  // u32[16] = m_pJsPlatform (null)
}

/**
 * @param {number} formInfo
 * @param {number} docHandle
 * @param {number} formHandle
 */
function _registerFormContext(formInfo, docHandle, formHandle) {
  formContextsByInfo[formInfo] = {
    docHandle,
    formHandle,
    notifyCallbackId: 0,
    currentPageHandle: 0,
    openPages: new Map(),
    handleToIndex: new Map(),
  };
  formInfoByDoc[docHandle] = formInfo;
}

/**
 * @param {number} docHandle
 */
function _disposeFormContext(docHandle) {
  const info = formInfoByDoc[docHandle];
  if (info === undefined) return;
  delete formContextsByInfo[info];
  delete formInfoByDoc[docHandle];
}
// [pdfrx_web: form support] }

/**
 * @param {number} docHandle
 * @param {boolean} useProgressiveLoading
 * @param {function():void} onDispose
 * @returns {PdfDocument|PdfError}
 */
function _loadDocument(docHandle, useProgressiveLoading, onDispose, password = '') {
  let formInfo = 0;
  let formHandle = 0;
  try {
    if (!docHandle) {
      const error = Pdfium.wasmExports.FPDF_GetLastError();
      const errorStr = _errorMappings[error];
      return {
        errorCode: error,
        errorCodeStr: _errorMappings[error],
        message: `Failed to load document`,
      };
    }

    missingFonts[docHandle] = {};
    lastMissingFonts = {};

    const pageCount = Pdfium.wasmExports.FPDF_GetPageCount(docHandle);
    const permissions = Pdfium.wasmExports.FPDF_GetDocPermissions(docHandle);
    const securityHandlerRevision = Pdfium.wasmExports.FPDF_GetSecurityHandlerRevision(docHandle);

    const formInfoSize = 35 * 4;
    formInfo = Pdfium.wasmExports.malloc(formInfoSize);
    // [pdfrx_web: form support] populate FPDF_FORMFILLINFO callbacks so FORM_On*
    // input can be routed through the form-fill module without null-pointer traps.
    _initFormFillInfo(formInfo, docHandle);
    formHandle = Pdfium.wasmExports.FPDFDOC_InitFormFillEnvironment(docHandle, formInfo);
    _registerFormContext(formInfo, docHandle, formHandle);

    const pages = _loadPagesInLimitedTime(docHandle, 0, useProgressiveLoading ? 1 : null);
    if (useProgressiveLoading) {
      const firstPage = pages[0];
      for (let i = 1; i < pageCount; i++) {
        pages.push({
          pageIndex: i,
          width: firstPage.width,
          height: firstPage.height,
          rotation: firstPage.rotation,
          isLoaded: false,
          bbLeft: 0,
          bbBottom: 0,
        });
      }
    }
    disposers[docHandle] = onDispose;
    documentPasswords[docHandle] = password;
    _updateMissingFonts(docHandle);

    return {
      docHandle: docHandle,
      permissions: permissions,
      securityHandlerRevision: securityHandlerRevision,
      pages: pages,
      formHandle: formHandle,
      formInfo: formInfo,
      missingFonts: missingFonts[docHandle],
    };
  } catch (e) {
    try {
      if (formHandle !== 0) Pdfium.wasmExports.FPDFDOC_ExitFormFillEnvironment(formHandle);
    } catch (e) {}
    _disposeFormContext(docHandle); // [pdfrx_web: form support]
    Pdfium.wasmExports.free(formInfo);
    delete disposers[docHandle];
    delete documentPasswords[docHandle];
    onDispose();
    throw e;
  }
}

/**
 * @param {number} docHandle
 * @param {number} pagesLoadedCountSoFar
 * @param {number|null} maxPageCountToLoadAdditionally
 * @param {number} timeoutMs
 * @returns {PdfPage[]}
 */
function _loadPagesInLimitedTime(docHandle, pagesLoadedCountSoFar, maxPageCountToLoadAdditionally, timeoutMs) {
  const pageCount = Pdfium.wasmExports.FPDF_GetPageCount(docHandle);
  const end =
    maxPageCountToLoadAdditionally == null
      ? pageCount
      : Math.min(pageCount, pagesLoadedCountSoFar + maxPageCountToLoadAdditionally);
  const t = timeoutMs != null ? Date.now() + timeoutMs : null;
  /** @type {PdfPage[]} */
  const pages = [];
  _resetMissingFonts();
  for (let i = pagesLoadedCountSoFar; i < end; i++) {
    const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, i);
    if (!pageHandle) {
      const error = Pdfium.wasmExports.FPDF_GetLastError();
      throw new Error(`FPDF_LoadPage failed (${_getErrorMessage(error)})`);
    }

    const rectBuffer = Pdfium.wasmExports.malloc(4 * 4); // FS_RECTF: float[4]
    Pdfium.wasmExports.FPDF_GetPageBoundingBox(pageHandle, rectBuffer);
    const rect = new Float32Array(Pdfium.memory.buffer, rectBuffer, 4);
    const bbLeft = rect[0];
    const bbBottom = rect[3];
    Pdfium.wasmExports.free(rectBuffer);

    pages.push({
      pageIndex: i,
      width: Pdfium.wasmExports.FPDF_GetPageWidthF(pageHandle),
      height: Pdfium.wasmExports.FPDF_GetPageHeightF(pageHandle),
      rotation: Pdfium.wasmExports.FPDFPage_GetRotation(pageHandle),
      isLoaded: true,
      bbLeft: bbLeft,
      bbBottom: bbBottom,
    });
    Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
    if (t != null && Date.now() > t) {
      break;
    }
  }
  _updateMissingFonts(docHandle);
  return pages;
}

/**
 * @param {number} docHandle
 * @param {number} pagesLoadedCountSoFar
 * @param {number|null} maxPageCountToLoadAdditionally
 * @param {number} timeoutMs
 * @returns {Promise<PdfPage[]>}
 */
async function _loadPagesInLimitedTimeAsync(docHandle, pagesLoadedCountSoFar, maxPageCountToLoadAdditionally, timeoutMs) {
  const pageCount = Pdfium.wasmExports.FPDF_GetPageCount(docHandle);
  const end =
    maxPageCountToLoadAdditionally == null
      ? pageCount
      : Math.min(pageCount, pagesLoadedCountSoFar + maxPageCountToLoadAdditionally);
  const t = timeoutMs != null ? Date.now() + timeoutMs : null;
  /** @type {PdfPage[]} */
  const pages = [];
  _resetMissingFonts();
  for (let i = pagesLoadedCountSoFar; i < end; i++) {
    await _ensurePageAvailable(docHandle, i);
    const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, i);
    if (!pageHandle) {
      const error = Pdfium.wasmExports.FPDF_GetLastError();
      throw new Error(`FPDF_LoadPage failed (${_getErrorMessage(error)})`);
    }

    const rectBuffer = Pdfium.wasmExports.malloc(4 * 4); // FS_RECTF: float[4]
    Pdfium.wasmExports.FPDF_GetPageBoundingBox(pageHandle, rectBuffer);
    const rect = new Float32Array(Pdfium.memory.buffer, rectBuffer, 4);
    const bbLeft = rect[0];
    const bbBottom = rect[3];
    Pdfium.wasmExports.free(rectBuffer);

    pages.push({
      pageIndex: i,
      width: Pdfium.wasmExports.FPDF_GetPageWidthF(pageHandle),
      height: Pdfium.wasmExports.FPDF_GetPageHeightF(pageHandle),
      rotation: Pdfium.wasmExports.FPDFPage_GetRotation(pageHandle),
      isLoaded: true,
      bbLeft: bbLeft,
      bbBottom: bbBottom,
    });
    Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
    if (t != null && Date.now() > t) {
      break;
    }
  }
  _updateMissingFonts(docHandle);
  return pages;
}

/**
 * @param {{docHandle: number, loadUnitDuration: number}} params
 * @returns {{pages: PdfPage[], missingFonts: FontQueries}}
 */
async function loadPagesProgressively(params) {
  const { docHandle, firstPageIndex, loadUnitDuration } = params;
  const pages = await _loadPagesInLimitedTimeAsync(docHandle, firstPageIndex, null, loadUnitDuration);
  return { pages, missingFonts: missingFonts[docHandle] };
}

/**
 * 
 * @param {{docHandle: number, pageIndices: number[]|undefined, currentPagesCount: number}} params
 * @returns {{pages: PdfPage[], missingFonts: FontQueries}}
 */
async function reloadPages(params) {
  const { docHandle, pageIndices, currentPagesCount } = params;
  /** @type {PdfPage[]} */
  const pages = [];
  const pageCount = Pdfium.wasmExports.FPDF_GetPageCount(docHandle);
  /** @type {number[]} */
  var indicesToLoad = [];
  if (pageIndices) {
    for (const pageIndex of pageIndices) {
      if (pageIndex < 0 || pageIndex >= pageCount) {
        throw new Error(`Invalid page index ${pageIndex} (page count: ${pageCount})`);
      }
      if (pageIndex < currentPagesCount) {
        indicesToLoad.push(pageIndex);
      }
    }
    for (let i = currentPagesCount; i < pageCount; i++) {
      indicesToLoad.push(i);
    }
  } else {
    for (let i = 0; i < pageCount; i++) {
      indicesToLoad.push(i);
    }
  }

  _resetMissingFonts();
  for (const pageIndex of indicesToLoad) {
    await _ensurePageAvailable(docHandle, pageIndex);
    const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, pageIndex);
    if (!pageHandle) {
      const error = Pdfium.wasmExports.FPDF_GetLastError();
      throw new Error(`FPDF_LoadPage failed (${_getErrorMessage(error)})`);
    }
    const rectBuffer = Pdfium.wasmExports.malloc(4 * 4); // FS_RECTF: float[4]
    Pdfium.wasmExports.FPDF_GetPageBoundingBox(pageHandle, rectBuffer);
    const rect = new Float32Array(Pdfium.memory.buffer, rectBuffer, 4);
    const bbLeft = rect[0];
    const bbBottom = rect[3];
    Pdfium.wasmExports.free(rectBuffer);
    pages.push({
      pageIndex: pageIndex,
      width: Pdfium.wasmExports.FPDF_GetPageWidthF(pageHandle),
      height: Pdfium.wasmExports.FPDF_GetPageHeightF(pageHandle),
      rotation: Pdfium.wasmExports.FPDFPage_GetRotation(pageHandle),
      isLoaded: true,
      bbLeft: bbLeft,
      bbBottom: bbBottom,
    });
    Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
  }
  return { pages, missingFonts: missingFonts[docHandle] };
}

/**
 * @param {{formHandle: number, formInfo: number, docHandle: number}} params
 */
function closeDocument(params) {
  // [pdfrx_web: form support] close any pages still open for interactive editing
  // and drop the form context before tearing down the form environment.
  const ctx = _formCtxByDoc(params.docHandle);
  if (ctx && params.formHandle) {
    for (const pageHandle of ctx.openPages.values()) {
      try {
        Pdfium.wasmExports.FORM_OnBeforeClosePage(pageHandle, params.formHandle);
      } catch (e) {}
      try {
        Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
      } catch (e) {}
    }
  }
  _disposeFormContext(params.docHandle);
  if (params.formHandle) {
    try {
      Pdfium.wasmExports.FPDFDOC_ExitFormFillEnvironment(params.formHandle);
    } catch (e) {}
  }
  _closeFreeTextFonts(params.docHandle);
  Pdfium.wasmExports.free(params.formInfo);
  Pdfium.wasmExports.FPDF_CloseDocument(params.docHandle);
  disposers[params.docHandle]();
  delete disposers[params.docHandle];
  delete documentPasswords[params.docHandle];
  delete missingFonts[params.docHandle];
  return { message: 'Document closed' };
}

/**
 * @typedef {{pageIndex: number, command: string, params: number[]}} PdfDest
 * @typedef {{title: string, dest: PdfDest, children: OutlineNode[]}} OutlineNode
 */

/**
 * @param {{docHandle: number}} params
 * @return {OutlineNode[]}
 */
function loadOutline(params) {
  return {
    outline: _getOutlineNodeSiblings(
      Pdfium.wasmExports.FPDFBookmark_GetFirstChild(params.docHandle, null),
      params.docHandle
    ),
  };
}

/**
 * @param {number} bookmark
 * @param {number} docHandle
 * @return {OutlineNode[]}
 */
function _getOutlineNodeSiblings(bookmark, docHandle) {
  /** @type {OutlineNode[]} */
  const siblings = [];
  while (bookmark) {
    const titleBufSize = Pdfium.wasmExports.FPDFBookmark_GetTitle(bookmark, null, 0);
    const titleBuf = Pdfium.wasmExports.malloc(titleBufSize);
    Pdfium.wasmExports.FPDFBookmark_GetTitle(bookmark, titleBuf, titleBufSize);
    const title = StringUtils.utf16BytesToString(new Uint8Array(Pdfium.memory.buffer, titleBuf, titleBufSize));
    Pdfium.wasmExports.free(titleBuf);
    siblings.push({
      title: title,
      dest: _pdfDestFromDest(Pdfium.wasmExports.FPDFBookmark_GetDest(docHandle, bookmark), docHandle),
      children: _getOutlineNodeSiblings(Pdfium.wasmExports.FPDFBookmark_GetFirstChild(docHandle, bookmark), docHandle),
    });
    bookmark = Pdfium.wasmExports.FPDFBookmark_GetNextSibling(docHandle, bookmark);
  }
  return siblings;
}

/**
 * @param {{docHandle: number, pageIndex: number}} params
 * @return {number} Page handle
 */
async function loadPage(params) {
  await _ensurePageAvailable(params.docHandle, params.pageIndex);
  const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(params.docHandle, params.pageIndex);
  if (!pageHandle) {
    throw new Error(`Failed to load page ${params.pageIndex} from document ${params.docHandle}`);
  }
  return { pageHandle: pageHandle };
}

/**
 * @param {{pageHandle: number}} params
 */
function closePage(params) {
  Pdfium.wasmExports.FPDF_ClosePage(params.pageHandle);
  return { message: 'Page closed' };
}

/**
 *
 * @param {{
 * docHandle: number,
 * pageIndex: number,
 * x: number,
 * y: number,
 * width: number,
 * height: number,
 * fullWidth: number,
 * fullHeight: number,
 * backgroundColor: number,
 * rotation: number,
 * annotationRenderingMode: number,
 * flags: number,
 * formHandle: number
 * }} params
 * @returns {{
 * imageData: ArrayBuffer,
 * width: number,
 * height: number,
 * missingFonts: FontQueries
 * }}
 */
async function renderPage(params) {
  const {
    docHandle,
    pageIndex,
    x = 0,
    y = 0,
    width = 800,
    height = 600,
    fullWidth = width,
    fullHeight = height,
    backgroundColor,
    rotation,
    annotationRenderingMode = 0,
    flags = 0,
    formHandle,
  } = params;

  let pageHandle = 0;
  let bufferPtr = 0;
  let bitmap = 0;

  try {
    _resetMissingFonts();
    await _ensurePageAvailable(docHandle, pageIndex);
    pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, pageIndex);
    if (!pageHandle) {
      throw new Error(`Failed to load page ${pageIndex} from document ${docHandle}`);
    }

    const bufferSize = width * height * 4;
    bufferPtr = Pdfium.wasmExports.malloc(bufferSize);
    if (!bufferPtr) {
      throw new Error('Failed to allocate memory for rendering');
    }
    const FPDFBitmap_BGRA = 4;
    bitmap = Pdfium.wasmExports.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, bufferPtr, width * 4);
    if (!bitmap) {
      throw new Error('Failed to create bitmap for rendering');
    }

    Pdfium.wasmExports.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, backgroundColor);

    const FPDF_ANNOT = 1;
    const PdfAnnotationRenderingMode_none = 0;
    const PdfAnnotationRenderingMode_annotation = 1;
    const PdfAnnotationRenderingMode_annotationAndForms = 2;
    // [pdfrx_web: annotation support] formsOnly (3): draw form widgets via
    // FPDF_FFLDraw but omit the FPDF_ANNOT flag, so non-widget annotations are
    // left for the viewer's SVG overlay to paint (avoids canvas/overlay double-draw).
    const PdfAnnotationRenderingMode_formsOnly = 3;
    const premultipliedAlpha = 0x80000000;

    const drawAnnots =
      annotationRenderingMode === PdfAnnotationRenderingMode_annotation ||
      annotationRenderingMode === PdfAnnotationRenderingMode_annotationAndForms;
    const drawForms =
      annotationRenderingMode === PdfAnnotationRenderingMode_annotationAndForms ||
      annotationRenderingMode === PdfAnnotationRenderingMode_formsOnly;

    const pdfiumFlags = (flags & 0xffff) | (drawAnnots ? FPDF_ANNOT : 0);
    Pdfium.wasmExports.FPDF_RenderPageBitmap(bitmap, pageHandle, -x, -y, fullWidth, fullHeight, rotation, pdfiumFlags);

    if (formHandle && drawForms) {
      Pdfium.wasmExports.FPDF_FFLDraw(formHandle, bitmap, pageHandle, -x, -y, fullWidth, fullHeight, rotation, flags);
    }
    // pdfium renders BGRA; emit RGBA so the result is directly Canvas/WebGL-ready
    // on the web (no web consumer wants BGRA). The B<->R swap is folded into the
    // copy that happens here anyway, so it is effectively free.
    // [pdfrx_web: RGBA output patch — reapplied by scripts/sync-assets.mjs]
    const src = new Uint8Array(Pdfium.memory.buffer, bufferPtr, bufferSize);
    let copiedBuffer = new ArrayBuffer(bufferSize);
    let dest = new Uint8Array(copiedBuffer);
    if (flags & premultipliedAlpha) {
      for (let i = 0; i < src.length; i += 4) {
        const a = src[i + 3];
        dest[i] = (src[i + 2] * a + 128) >> 8;
        dest[i + 1] = (src[i + 1] * a + 128) >> 8;
        dest[i + 2] = (src[i] * a + 128) >> 8;
        dest[i + 3] = a;
      }
    } else {
      for (let i = 0; i < src.length; i += 4) {
        dest[i] = src[i + 2];
        dest[i + 1] = src[i + 1];
        dest[i + 2] = src[i];
        dest[i + 3] = src[i + 3];
      }
    }

    _updateMissingFonts(docHandle);

    return {
      result: {
        imageData: copiedBuffer,
        width: width,
        height: height,
        missingFonts: missingFonts[docHandle],
      },
      transfer: [copiedBuffer],
    };
  } finally {
    Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
    Pdfium.wasmExports.FPDFBitmap_Destroy(bitmap);
    Pdfium.wasmExports.free(bufferPtr);
  }
}

function _memset(ptr, value, num) {
  const buffer = new Uint8Array(Pdfium.memory.buffer, ptr, num);
  for (let i = 0; i < num; i++) {
    buffer[i] = value;
  }
}

/**
 *
 * @param {{pageIndex: number, docHandle: number}} params
 * @returns {{fullText: string, charRects: number[][], missingFonts: FontQueries}}
 */
async function loadText(params) {
  _resetMissingFonts();
  const { pageIndex, docHandle } = params;
  await _ensurePageAvailable(docHandle, pageIndex);
  const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, pageIndex);
  const textPage = Pdfium.wasmExports.FPDFText_LoadPage(pageHandle);
  if (textPage == null) return { fullText: '' };

  const count = Pdfium.wasmExports.FPDFText_CountChars(textPage);
  let fullText = '';

  const rectBuffer = Pdfium.wasmExports.malloc(8 * 4); // double[4]
  const rect = new Float64Array(Pdfium.memory.buffer, rectBuffer, 4);
  let charRects = [];
  for (let i = 0; i < count; i++) {
    fullText += String.fromCodePoint(Pdfium.wasmExports.FPDFText_GetUnicode(textPage, i));
    Pdfium.wasmExports.FPDFText_GetCharBox(
      textPage,
      i,
      rectBuffer, // L
      rectBuffer + 8 * 2, // R
      rectBuffer + 8 * 3, // B
      rectBuffer + 8 // T
    );
    charRects.push(Array.from(rect));
  }
  Pdfium.wasmExports.free(rectBuffer);

  Pdfium.wasmExports.FPDFText_ClosePage(textPage);
  Pdfium.wasmExports.FPDF_ClosePage(pageHandle);

  _updateMissingFonts(docHandle);
  return { fullText, charRects, missingFonts: missingFonts[docHandle] };
}

/**
 * @typedef {{rects: number[][], dest: url: string}} PdfUrlLink
 * @typedef {{rects: number[][], dest: PdfDest}} PdfDestLink
 */

/**
 * @param {{docHandle: number, pageIndex: number, enableAutoLinkDetection: boolean}} params
 * @returns {{links: Array<PdfUrlLink|PdfDestLink>}}
 */
async function loadLinks(params) {
  await _ensurePageAvailable(params.docHandle, params.pageIndex);
  const links = [..._loadAnnotLinks(params), ...(params.enableAutoLinkDetection ? _loadWebLinks(params) : [])];
  return {
    links: links,
  };
}

/**
 * @param {{docHandle: number, pageIndex: number, enableAutoLinkDetection: boolean}} params
 * @returns {Array<PdfUrlLink>}
 */
function _loadWebLinks(params) {
  const { pageIndex, docHandle } = params;
  const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, pageIndex);
  const textPage = Pdfium.wasmExports.FPDFText_LoadPage(pageHandle);
  if (textPage == null) return [];
  const linkPage = Pdfium.wasmExports.FPDFLink_LoadWebLinks(textPage);
  if (linkPage == null) return [];

  const links = [];
  const count = Pdfium.wasmExports.FPDFLink_CountWebLinks(linkPage);
  const rectBuffer = Pdfium.wasmExports.malloc(8 * 4); // double[4]
  for (let i = 0; i < count; i++) {
    const rectCount = Pdfium.wasmExports.FPDFLink_CountRects(linkPage, i);
    const rects = [];
    for (let j = 0; j < rectCount; j++) {
      Pdfium.wasmExports.FPDFLink_GetRect(linkPage, i, j, rectBuffer, rectBuffer + 8, rectBuffer + 16, rectBuffer + 24);
      rects.push(Array.from(new Float64Array(Pdfium.memory.buffer, rectBuffer, 4)));
    }
    links.push({
      kind: 'detected',
      id: null,
      rects: rects,
      url: _getLinkUrl(linkPage, i),
    });
  }
  Pdfium.wasmExports.free(rectBuffer);
  Pdfium.wasmExports.FPDFLink_CloseWebLinks(linkPage);
  Pdfium.wasmExports.FPDFText_ClosePage(textPage);
  Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
  return links;
}

/**
 * @param {number} linkPage
 * @param {number} linkIndex
 * @returns {string}
 */
function _getLinkUrl(linkPage, linkIndex) {
  const urlLength = Pdfium.wasmExports.FPDFLink_GetURL(linkPage, linkIndex, null, 0);
  const urlBuffer = Pdfium.wasmExports.malloc(urlLength * 2);
  Pdfium.wasmExports.FPDFLink_GetURL(linkPage, linkIndex, urlBuffer, urlLength);
  const url = StringUtils.utf16BytesToString(new Uint8Array(Pdfium.memory.buffer, urlBuffer, urlLength * 2));
  Pdfium.wasmExports.free(urlBuffer);
  return url;
}

/**
 * @param {{docHandle: number, pageIndex: number}} params
 * @returns {Array<PdfDestLink|PdfUrlLink>}
 */
function _loadAnnotLinks(params) {
  const { pageIndex, docHandle } = params;
  const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, pageIndex);
  const count = Pdfium.wasmExports.FPDFPage_GetAnnotCount(pageHandle);
  const rectF = Pdfium.wasmExports.malloc(4 * 4);
  const links = [];
  for (let i = 0; i < count; i++) {
    const annot = Pdfium.wasmExports.FPDFPage_GetAnnot(pageHandle, i);
    if (Pdfium.wasmExports.FPDFAnnot_GetSubtype(annot) !== 2) {
      Pdfium.wasmExports.FPDFPage_CloseAnnot(annot);
      continue;
    }
    Pdfium.wasmExports.FPDFAnnot_GetRect(annot, rectF);
    const [l, t, r, b] = new Float32Array(Pdfium.memory.buffer, rectF, 4);
    const rect = [l, t > b ? t : b, r, t > b ? b : t];

    const annotation = _getAnnotationContent(annot);

    const dest = _processAnnotDest(annot, docHandle);
    if (dest) {
      links.push({
        kind: 'annotation',
        id: _getAnnotField('NM', annot) || `@${i}`,
        rects: [rect],
        dest: _pdfDestFromDest(dest, docHandle),
        annotation: annotation,
      });
    } else {
      const url = _processAnnotLink(annot, docHandle);
      if (url) {
        links.push({
          kind: 'annotation',
          id: _getAnnotField('NM', annot) || `@${i}`,
          rects: [rect],
          url: url,
          annotation: annotation,
        });
      }
    }
    Pdfium.wasmExports.FPDFPage_CloseAnnot(annot);
  }
  Pdfium.wasmExports.free(rectF);
  Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
  return links;
}

/**
 * @typedef {{title: string|null, content: string|null, modificationDate: string|null, creationDate: string|null, subject: string|null}} PdfAnnotationContent
 */

/**
 * Get annotation content with all metadata fields
 * @param {number} annot Annotation handle
 * @returns {PdfAnnotationContent|null} Annotation object or null if no content
 */
function _getAnnotationContent(annot) {
  const title = _getAnnotField('T', annot); // Title (Author)
  const content = _getAnnotField('Contents', annot); // Content
  const modDate = _getAnnotField('M', annot); // Modification date
  const creationDate = _getAnnotField('CreationDate', annot); // Creation date
  const subject = _getAnnotField('Subj', annot); // Subject
  if (!title && !content && !modDate && !creationDate && !subject) {
    return null;
  }

  return {
    title: title,
    content: content,
    modificationDate: modDate,
    creationDate: creationDate,
    subject: subject,
  };
}

/**
 * Helper function to get annotation field value
 * @param {string} fieldName PDF annotation field name
 * @returns {string|null}
 */
function _getAnnotField(fieldName, annot) {
  const key = StringUtils.allocateUTF8(fieldName);
  try {
    const length = Pdfium.wasmExports.FPDFAnnot_GetStringValue(annot, key, null, 0);
    if (length <= 0) return null;

    // FPDFAnnot_GetStringValue reports a byte count (including the UTF-16 NUL),
    // not a count of UTF-16 code units. Reading twice that size makes the
    // decoder scan uninitialised heap data beyond the returned PDF string.
    const buffer = Pdfium.wasmExports.malloc(length);
    try {
      Pdfium.wasmExports.FPDFAnnot_GetStringValue(annot, key, buffer, length);
      const value = StringUtils.utf16BytesToString(new Uint8Array(Pdfium.memory.buffer, buffer, length));
      return value && value.trim() !== '' ? value : null;
    } finally {
      Pdfium.wasmExports.free(buffer);
    }
  } finally {
    StringUtils.freeUTF8(key);
  }
}

/**
 *
 * @param {number} annot
 * @param {number} docHandle
 * @returns {number|null} Dest
 */
function _processAnnotDest(annot, docHandle) {
  const link = Pdfium.wasmExports.FPDFAnnot_GetLink(annot);

  // firstly check the direct dest
  const dest = Pdfium.wasmExports.FPDFLink_GetDest(docHandle, link);
  if (dest) return dest;

  const action = Pdfium.wasmExports.FPDFLink_GetAction(link);
  if (!action) return null;
  const PDFACTION_GOTO = 1;
  switch (Pdfium.wasmExports.FPDFAction_GetType(action)) {
    case PDFACTION_GOTO:
      return Pdfium.wasmExports.FPDFAction_GetDest(docHandle, action);
    default:
      return null;
  }
}

/**
 * @param {number} annot
 * @param {number} docHandle
 * @returns {string|null} URI
 */
function _processAnnotLink(annot, docHandle) {
  const link = Pdfium.wasmExports.FPDFAnnot_GetLink(annot);
  const action = Pdfium.wasmExports.FPDFLink_GetAction(link);
  if (!action) return null;
  const PDFACTION_URI = 3;
  switch (Pdfium.wasmExports.FPDFAction_GetType(action)) {
    case PDFACTION_URI:
      const size = Pdfium.wasmExports.FPDFAction_GetURIPath(docHandle, action, null, 0);
      const buf = Pdfium.wasmExports.malloc(size);
      Pdfium.wasmExports.FPDFAction_GetURIPath(docHandle, action, buf, size);
      const uri = StringUtils.utf8BytesToString(new Uint8Array(Pdfium.memory.buffer, buf, size));
      Pdfium.wasmExports.free(buf);
      return uri;
    default:
      return null;
  }
}

/// [PDF 32000-1:2008, 12.3.2.2 Explicit Destinations, Table 151](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf#page=374)
const pdfDestCommands = ['unknown', 'xyz', 'fit', 'fitH', 'fitV', 'fitR', 'fitB', 'fitBH', 'fitBV'];

/**
 * @param {number} dest
 * @param {number} docHandle
 * @returns {PdfDest|null}
 */
function _pdfDestFromDest(dest, docHandle) {
  if (dest === 0) return null;
  const buf = Pdfium.wasmExports.malloc(40);
  const pageIndex = Pdfium.wasmExports.FPDFDest_GetDestPageIndex(docHandle, dest);
  const type = Pdfium.wasmExports.FPDFDest_GetView(dest, buf, buf + 4);
  const [count] = new Int32Array(Pdfium.memory.buffer, buf, 1);
  const params = Array.from(new Float32Array(Pdfium.memory.buffer, buf + 4, count));
  Pdfium.wasmExports.free(buf);
  if (type !== 0) {
    return {
      pageIndex,
      command: pdfDestCommands[type],
      params,
    };
  }
  return null;
}

/**
 * Install the system font info in PDFium.
 */
async function _installFontMapper() {
  if (pdfFontMapper) return;
  const fontMapper = new PdfFontMapper();
  fontMapper.install();
  pdfFontMapper = fontMapper;
  Pdfium.wasmExports.FPDF_SetSystemFontInfo(fontMapper.sysFontInfo);
  await _reloadFontCache();
}

async function _reloadFontCache() {
  for (const font of await PdfFontPersistentCache.instance.loadAll()) {
    pdfFontMapper?.addFontData(font);
  }
}

/**
 * Reload fonts into the current mapper.
 */
async function reloadFonts() {
  console.log('Reloading fonts in PDFium font mapper...');
  await _reloadFontCache();
  return { message: 'Fonts reloaded' };
}
let pdfFontMapper = null;

const fontNamesToIgnore = {
  Symbol: true,
  ZapfDingbats: true,
};

// Increment when persisted font mappings are no longer compatible with the
// current resolver or mapper behavior. An upgrade clears the old face-keyed
// records so changed fallback classification can run again.
const PDF_FONT_CACHE_DATABASE_VERSION = 2;

class PdfFontPersistentCache {
  static instance = new PdfFontPersistentCache();

  constructor() {
    this.dbName = 'pdfrx.fonts';
    this.storeName = 'fonts';
    this.dbPromise = null;
  }

  async open() {
    if (this.dbPromise) return this.dbPromise;
    if (!self.indexedDB) {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, PDF_FONT_CACHE_DATABASE_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'face' });
        } else if (event.oldVersion < PDF_FONT_CACHE_DATABASE_VERSION) {
          request.transaction.objectStore(this.storeName).clear();
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`Opening IndexedDB ${this.dbName} was blocked.`));
    }).catch((error) => {
      console.warn('Failed to open font cache database:', error);
      return null;
    });
    return this.dbPromise;
  }

  async loadAll() {
    const db = await this.open();
    if (!db) return [];
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const request = transaction.objectStore(this.storeName).getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    }).catch((error) => {
      console.warn('Failed to load cached fonts:', error);
      return [];
    });
  }

  async put({ face, data, resolvedFace }) {
    const db = await this.open();
    if (!db) return;
    const storedData = data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      transaction.objectStore(this.storeName).put({ face, resolvedFace, data: storedData });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }).catch((error) => {
      console.warn(`Failed to store cached font "${face}":`, error);
    });
  }

  async clear() {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      transaction.objectStore(this.storeName).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }).catch((error) => {
      console.warn('Failed to clear cached fonts:', error);
    });
  }
}

class PdfFontMapper {
  constructor() {
    this.sysFontInfo = Pdfium.wasmExports.malloc(9 * 4);
    new Int32Array(Pdfium.memory.buffer, this.sysFontInfo, 9).fill(0);
    new Int32Array(Pdfium.memory.buffer, this.sysFontInfo, 1)[0] = 2;
    this.missingFonts = {};
    this.cachedFontsByFace = {};
    this.mappedFonts = {};
    this.aliases = {};
    this.functionPointers = [];
    this.nextMappedFontHandle = 1;
  }

  install() {
    const sysFontInfo = new Int32Array(Pdfium.memory.buffer, this.sysFontInfo, 9);
    sysFontInfo[3] = this._addFunction(
      (pThis, weight, bItalic, charset, pitchFamily, face, bExact) =>
        this.mapFont(pThis, weight, bItalic, charset, pitchFamily, face, bExact),
      'iiiiiiii'
    );
    sysFontInfo[5] = this._addFunction(
      (pThis, hFont, table, buffer, bufSize) => this.getFontData(pThis, hFont, table, buffer, bufSize),
      'iiiiii'
    );
    sysFontInfo[6] = this._addFunction((pThis, hFont, buffer, bufSize) => this.getFaceName(pThis, hFont, buffer, bufSize), 'iiiii');
    sysFontInfo[7] = this._addFunction((pThis, hFont) => this.getFontCharset(pThis, hFont), 'iii');
    sysFontInfo[8] = this._addFunction((pThis, hFont) => this.deleteFont(pThis, hFont), 'vii');
  }

  dispose() {
    this.mappedFonts = {};
    for (const pointer of this.functionPointers) {
      Pdfium.removeFunction(pointer);
    }
    this.functionPointers = [];
    Pdfium.wasmExports.free(this.sysFontInfo);
  }

  _addFunction(func, sig) {
    const pointer = Pdfium.addFunction(func, sig);
    this.functionPointers.push(pointer);
    return pointer;
  }

  addFontData({ face, data, resolvedFace }) {
    const font = { face, resolvedFace, data: new Uint8Array(data), charset: null };
    this.cachedFontsByFace[face] = font;
    if (resolvedFace && resolvedFace !== face) {
      this.aliases[face] = resolvedFace;
      this.cachedFontsByFace[resolvedFace] = font;
    }
    delete this.missingFonts[face];
    delete lastMissingFonts[face];
  }

  clear() {
    this.cachedFontsByFace = {};
    this.aliases = {};
    this.missingFonts = {};
  }

  getAndClearMissingFonts() {
    const result = this.missingFonts;
    this.missingFonts = {};
    return result;
  }

  mapFont(_pThis, weight, bItalic, charset, pitchFamily, face, bExact) {
    const faceName = StringUtils.utf8BytesToString(new Uint8Array(Pdfium.memory.buffer, face));
    const cachedFont = this.cachedFontsByFace[faceName] ?? this.cachedFontsByFace[this.aliases[faceName]];
    if (cachedFont) {
      cachedFont.charset ??= charset;
      if (bExact) new Int32Array(Pdfium.memory.buffer, bExact, 1)[0] = 1;
      return this._createMappedFontHandle(cachedFont);
    }
    if (!fontNamesToIgnore[faceName] && !this.missingFonts[faceName]) {
      this.missingFonts[faceName] = {
        face: faceName,
        weight: weight,
        italic: !!bItalic,
        charset: charset,
        pitchFamily: pitchFamily,
      };
      lastMissingFonts[faceName] = this.missingFonts[faceName];
    }
    return 0;
  }

  getFontData(_pThis, hFont, table, buffer, bufSize) {
    const font = this.mappedFonts[hFont];
    if (!font) return 0;
    const data = table === 0 ? font.data : getFontTableData(font.data, table);
    if (!data) return 0;
    if (!buffer || bufSize < data.byteLength) return data.byteLength;
    new Uint8Array(Pdfium.memory.buffer, buffer, data.byteLength).set(data);
    return data.byteLength;
  }

  getFaceName(_pThis, hFont, buffer, bufSize) {
    const font = this.mappedFonts[hFont];
    if (!font) return 0;
    const name = font.resolvedFace ?? font.face;
    const length = StringUtils.lengthBytesUTF8(name) + 1;
    if (!buffer || bufSize < length) return length;
    StringUtils.stringToUtf8Bytes(name, new Uint8Array(Pdfium.memory.buffer, buffer, length));
    return length;
  }

  getFontCharset(_pThis, hFont) {
    const font = this.mappedFonts[hFont];
    return font?.charset ?? 1;
  }

  deleteFont(_pThis, hFont) {
    if (!this.mappedFonts[hFont]) return;
    delete this.mappedFonts[hFont];
  }

  _createMappedFontHandle(font) {
    const handle = this.nextMappedFontHandle++;
    this.mappedFonts[handle] = font;
    return handle;
  }
}

function getFontTableData(data, table) {
  const fontOffset = getFontOffset(data);
  if (fontOffset === null || fontOffset + 12 > data.byteLength) return null;
  const numTables = readUint16(data, fontOffset + 4);
  let tableRecordOffset = fontOffset + 12;
  for (let i = 0; i < numTables; i++) {
    if (tableRecordOffset + 16 > data.byteLength) return null;
    if (readUint32(data, tableRecordOffset) === table) {
      const offset = readUint32(data, tableRecordOffset + 8);
      const length = readUint32(data, tableRecordOffset + 12);
      if (offset + length > data.byteLength) return null;
      return data.subarray(offset, offset + length);
    }
    tableRecordOffset += 16;
  }
  return null;
}

function getFontOffset(data) {
  if (data.byteLength < 12) return null;
  const ttcTag = 0x74746366;
  if (readUint32(data, 0) !== ttcTag) return 0;
  if (data.byteLength < 16) return null;
  const numFonts = readUint32(data, 8);
  if (numFonts < 1) return null;
  const offset = readUint32(data, 12);
  if (offset >= data.byteLength) return null;
  return offset;
}

function readUint16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data, offset) {
  return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

/**
 * Add font data to the font cache.
 * @param {{face: string, data: ArrayBuffer, resolvedFace: string|undefined}} params
 */
async function addFontData(params) {
  console.log(`Adding font data for face: ${params.face}`);
  const { face, data, resolvedFace } = params;
  pdfFontMapper?.addFontData({ face, data, resolvedFace });
  await PdfFontPersistentCache.instance.put({ face, data, resolvedFace });
  return { message: `Font ${face} added`, face: face };
}

async function clearAllFontData() {
  console.log(`Clearing all font data`);
  pdfFontMapper?.clear();
  await PdfFontPersistentCache.instance.clear();
  return { message: 'All font data cleared' };
}

/**
 * Assemble the document (apply page manipulations if any)
 * @param {{docHandle: number, pageIndices: number[]|undefined, importedPages: Object.<number, {docHandle: number, pageNumber: number}>|undefined, rotations: (number|null)[]|undefined}} params
 * @returns {{modified: boolean}}
 */
function assemble(params) {
  const { docHandle, pageIndices, importedPages, rotations } = params;

  // An omitted arrangement means no work. An explicitly empty arrangement
  // removes every physical page (including unplaced generated source pages).
  if (!pageIndices) {
    return { modified: false };
  }

  const originalLength = Pdfium.wasmExports.FPDF_GetPageCount(docHandle);

  // Check if there are any changes
  let hasChanges = pageIndices.length !== originalLength;
  if (!hasChanges) {
    for (let i = 0; i < pageIndices.length; i++) {
      if (pageIndices[i] !== i) {
        hasChanges = true;
        break;
      }
    }
  }

  // Check for rotation changes
  if (!hasChanges && rotations) {
    for (let i = 0; i < rotations.length; i++) {
      if (rotations[i] != null) {
        hasChanges = true;
        break;
      }
    }
  }

  if (!hasChanges) {
    return { modified: false };
  }

  // Perform the shuffle using the PDFium page manipulation functions
  _shuffleInPlaceAccordingToIndices(docHandle, pageIndices, originalLength, importedPages);

  // Apply rotations if specified
  if (rotations) {
    for (let i = 0; i < rotations.length; i++) {
      const rotation = rotations[i];
      if (rotation != null) {
        const page = Pdfium.wasmExports.FPDF_LoadPage(docHandle, i);
        Pdfium.wasmExports.FPDFPage_SetRotation(page, rotation);
        Pdfium.wasmExports.FPDF_ClosePage(page);
      }
    }
  }

  return { modified: true };
}

/**
 * Internal class to track page tokens during shuffling
 */
class _ArrayOfItemsToken {
  /**
   * @param {number|null} originalIndex
   * @param {boolean} isOriginal
   */
  constructor(originalIndex, isOriginal) {
    this.originalIndex = originalIndex;
    this.isOriginal = isOriginal;
  }
}

/**
 * Shuffle pages in place according to the given list of resulting item indices
 * @param {number} docHandle Document handle
 * @param {number[]} resultingItemIndices Array of page indices representing the desired order
 * @param {number} originalLength Original number of pages
 * @param {Object.<number, {docHandle: number, pageNumber: number}>|undefined} importedPages Map of negative indices to import info
 */
function _shuffleInPlaceAccordingToIndices(docHandle, resultingItemIndices, originalLength, importedPages) {
  if (resultingItemIndices.length === 0) {
    if (originalLength > 0) {
      _removePages(docHandle, 0, originalLength);
    }
    return;
  }

  const tokens = [];
  for (let i = 0; i < originalLength; i++) {
    tokens.push(new _ArrayOfItemsToken(i, true));
  }

  // Count usage of each original page
  const usageCounts = new Array(originalLength).fill(0);
  for (let i = 0; i < resultingItemIndices.length; i++) {
    const index = resultingItemIndices[i];
    if (index >= 0) {
      if (index >= originalLength) {
        throw new Error(`resultingItemIndices[${i}] = ${index} is out of range for current length ${originalLength}`);
      }
      usageCounts[index]++;
    }
  }

  // Remove unused pages (from end to beginning to maintain indices)
  for (let i = originalLength - 1; i >= 0; i--) {
    if (usageCounts[i] === 0) {
      _removePages(docHandle, i, 1);
      tokens.splice(i, 1);
    }
  }

  const placedCounts = new Array(originalLength).fill(0);
  let currentIndex = 0;

  while (currentIndex < resultingItemIndices.length) {
    if (currentIndex > tokens.length) {
      throw new Error(`Destination index ${currentIndex} is out of range for current length ${tokens.length}.`);
    }

    const target = resultingItemIndices[currentIndex];
    if (target >= 0) {
      const isFirst = placedCounts[target] === 0;
      if (isFirst) {
        // Find the original page
        let fromIndex = -1;
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i].originalIndex === target && tokens[i].isOriginal) {
            fromIndex = i;
            break;
          }
        }
        if (fromIndex === -1) {
          throw new Error(`Item at index ${target} could not be found for initial placement.`);
        }

        // Try to find consecutive pages to move as a chunk
        let chunkLength = 1;
        while (currentIndex + chunkLength < resultingItemIndices.length && fromIndex + chunkLength < tokens.length) {
          const nextTarget = resultingItemIndices[currentIndex + chunkLength];
          if (nextTarget < 0 || placedCounts[nextTarget] > 0) break;
          const nextToken = tokens[fromIndex + chunkLength];
          if (!nextToken.isOriginal || nextToken.originalIndex !== nextTarget) break;
          chunkLength++;
        }

        let placementIndex = currentIndex;
        if (fromIndex !== currentIndex) {
          const removalIndices = [];
          for (let offset = 0; offset < chunkLength; offset++) {
            removalIndices.push(fromIndex + offset);
          }

          _movePages(docHandle, fromIndex, currentIndex, chunkLength);

          // Update tokens
          const removedTokens = [];
          for (let i = removalIndices.length - 1; i >= 0; i--) {
            removedTokens.unshift(tokens.splice(removalIndices[i], 1)[0]);
          }

          let insertIndex = currentIndex;
          for (const index of removalIndices) {
            if (index < currentIndex) {
              insertIndex--;
            }
          }
          if (insertIndex < 0) insertIndex = 0;
          if (insertIndex > tokens.length) insertIndex = tokens.length;
          tokens.splice(insertIndex, 0, ...removedTokens);
          placementIndex = insertIndex;
        }

        for (let offset = 0; offset < chunkLength; offset++) {
          const token = tokens[placementIndex + offset];
          if (token.originalIndex !== null) {
            placedCounts[token.originalIndex]++;
          }
        }
        currentIndex += chunkLength;
        continue;
      } else {
        // Duplicate page
        let sourceIndex = -1;
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i].originalIndex === target) {
            sourceIndex = i;
            break;
          }
        }
        if (sourceIndex === -1) {
          throw new Error(`Item at index ${target} could not be found for duplication.`);
        }
        _duplicatePages(docHandle, sourceIndex, currentIndex, 1);
        tokens.splice(currentIndex, 0, new _ArrayOfItemsToken(target, false));
        placedCounts[target]++;
      }
    } else {
      // Negative index means importing from another document
      if (!importedPages || !importedPages[target]) {
        throw new Error(`Imported page info not found for negative index ${target}`);
      }
      const importInfo = importedPages[target];
      _insertImportedPage(docHandle, importInfo.docHandle, importInfo.pageNumber, currentIndex);
      tokens.splice(currentIndex, 0, new _ArrayOfItemsToken(null, false));
    }
    currentIndex++;
  }

  const expectedLength = resultingItemIndices.length;
  if (tokens.length > expectedLength) {
    const extra = tokens.length - expectedLength;
    _removePages(docHandle, expectedLength, extra);
    tokens.splice(expectedLength, extra);
  } else if (tokens.length < expectedLength) {
    throw new Error(`Internal length mismatch after shuffling (expected ${expectedLength}, got ${tokens.length}).`);
  }
}

/**
 * Move pages within a document
 * @param {number} docHandle Document handle
 * @param {number} fromIndex Starting index of pages to move
 * @param {number} toIndex Destination index
 * @param {number} count Number of pages to move
 */
function _movePages(docHandle, fromIndex, toIndex, count) {
  const pageIndices = Pdfium.wasmExports.malloc(count * 4); // Int32 array
  const pageIndicesView = new Int32Array(Pdfium.memory.buffer, pageIndices, count);
  for (let i = 0; i < count; i++) {
    pageIndicesView[i] = fromIndex + i;
  }
  Pdfium.wasmExports.FPDF_MovePages(docHandle, pageIndices, count, toIndex);
  Pdfium.wasmExports.free(pageIndices);
}

/**
 * Remove pages from a document
 * @param {number} docHandle Document handle
 * @param {number} index Starting index
 * @param {number} count Number of pages to remove
 */
function _removePages(docHandle, index, count) {
  for (let i = count - 1; i >= 0; i--) {
    Pdfium.wasmExports.FPDFPage_Delete(docHandle, index + i);
  }
}

/**
 * Duplicate pages within a document
 * @param {number} docHandle Document handle
 * @param {number} fromIndex Index of page to duplicate
 * @param {number} toIndex Destination index for the duplicate
 * @param {number} count Number of pages to duplicate
 */
function _duplicatePages(docHandle, fromIndex, toIndex, count) {
  const pageIndices = Pdfium.wasmExports.malloc(count * 4); // Int32 array
  const pageIndicesView = new Int32Array(Pdfium.memory.buffer, pageIndices, count);
  for (let i = 0; i < count; i++) {
    pageIndicesView[i] = fromIndex + i;
  }
  Pdfium.wasmExports.FPDF_ImportPagesByIndex(docHandle, docHandle, pageIndices, count, toIndex);
  Pdfium.wasmExports.free(pageIndices);
}

/**
 * Insert a page from another document
 * @param {number} destDocHandle Destination document handle
 * @param {number} srcDocHandle Source document handle
 * @param {number} srcPageIndex Source page index (0-based)
 * @param {number} destIndex Destination index
 */
function _insertImportedPage(destDocHandle, srcDocHandle, srcPageIndex, destIndex) {
  const pageIndices = Pdfium.wasmExports.malloc(4); // Int32 for one page
  const pageIndicesView = new Int32Array(Pdfium.memory.buffer, pageIndices, 1);
  pageIndicesView[0] = srcPageIndex;
  Pdfium.wasmExports.FPDF_ImportPagesByIndex(destDocHandle, srcDocHandle, pageIndices, 1, destIndex);
  Pdfium.wasmExports.free(pageIndices);
}

/**
 * Encode PDF document to bytes
 * @param {{docHandle: number, incremental: boolean, removeSecurity: boolean}} params
 * @returns {{data: ArrayBuffer}}
 */
function encodePdf(params) {
  const { docHandle, incremental = false, removeSecurity = false } = params;

  let buffer = new Uint8Array(1024 * 1024); // Start with 1MB buffer
  let totalSize = 0;

  // Create a callback function that will be called by PDFium to write data
  const writeCallback = Pdfium.addFunction((pThis, pData, size) => {
    void pThis; // Suppress unused parameter warning

    // Grow buffer if needed
    if (totalSize + size > buffer.length) {
      const newSize = Math.max(buffer.length * 2, totalSize + size);
      const newBuffer = new Uint8Array(newSize);
      newBuffer.set(buffer.subarray(0, totalSize));
      buffer = newBuffer;
    }

    // Copy data directly into buffer
    const chunk = new Uint8Array(Pdfium.memory.buffer, pData, size);
    buffer.set(chunk, totalSize);
    totalSize += size;

    return size;
  }, 'iiii');

  try {
    const fileWriteSize = 8; // sizeof(FPDF_FILEWRITE): version(4) + WriteBlock(4)
    const fileWrite = Pdfium.wasmExports.malloc(fileWriteSize);
    const fileWriteView = new Int32Array(Pdfium.memory.buffer, fileWrite, 2);
    fileWriteView[0] = 1; // version
    fileWriteView[1] = writeCallback; // WriteBlock function pointer

    // Determine flags based on parameters
    let flags;
    if (removeSecurity) {
      flags = 3; // FPDF_SAVE_NO_SECURITY(3)
    } else {
      flags = incremental ? 1 : 2; // FPDF_INCREMENTAL(1) or FPDF_NO_INCREMENTAL(2)
    }

    const result = Pdfium.wasmExports.FPDF_SaveAsCopy(docHandle, fileWrite, flags);
    Pdfium.wasmExports.free(fileWrite);

    if (!result) {
      throw new Error('FPDF_SaveAsCopy failed');
    }

    // Trim to the bytes actually written: subarray would keep the whole
    // (over-allocated, zero-padded) buffer alive behind combined.buffer.
    const combined = buffer.slice(0, totalSize);

    return {
      result: { data: combined.buffer },
      transfer: [combined.buffer],
    };
  } finally {
    Pdfium.removeFunction(writeCallback);
  }
}

/**
 * Creates an independent in-memory copy of a live document. The copy contains
 * native annotation/form changes but not the caller-side proxy arrangement.
 * @param {{docHandle: number}} params
 * @returns {PdfDocument|PdfError}
 */
function cloneDocument(params) {
  const encoded = encodePdf({ docHandle: params.docHandle, incremental: false, removeSecurity: false }).result;
  const data = encoded.data;
  const buffer = Pdfium.wasmExports.malloc(data.byteLength);
  if (buffer === 0) throw new Error(`Failed to allocate memory for cloned PDF (${data.byteLength} bytes)`);
  new Uint8Array(Pdfium.memory.buffer, buffer, data.byteLength).set(new Uint8Array(data));
  const password = documentPasswords[params.docHandle] ?? '';
  const passwordPtr = StringUtils.allocateUTF8(password);
  const docHandle = Pdfium.wasmExports.FPDF_LoadMemDocument(buffer, data.byteLength, passwordPtr);
  StringUtils.freeUTF8(passwordPtr);
  return _loadDocument(docHandle, false, () => Pdfium.wasmExports.free(buffer), password);
}

/**
 * Create a new empty PDF document
 * @returns {PdfDocument|PdfError}
 */
function createNewDocument() {
  const docHandle = Pdfium.wasmExports.FPDF_CreateNewDocument();
  return _loadDocument(docHandle, false, () => {});
}

/**
 * Create a PDF document with one page per image.
 * @param {Object} params Parameters object
 * @param {Array<Object>} params.pages One entry per page. Each is either
 *   `{ kind: 'jpeg', data: ArrayBuffer, width, height }` or
 *   `{ kind: 'pixels', pixels: ArrayBuffer, pixelWidth, pixelHeight, format, width, height }`,
 *   where `width`/`height` are page dimensions in PDF points and `format` is
 *   `'rgba8888'` or `'bgra8888'`.
 * @returns {PdfDocument|PdfError}
 */
async function createPagesFromImages(params) {
  const pages = params && params.pages;
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('No image pages provided');
  const pageCount = Pdfium.wasmExports.FPDF_GetPageCount(params.docHandle);
  try {
    for (let i = 0; i < pages.length; i++) {
      _addImagePage(params.docHandle, pageCount + i, pages[i]);
    }
  } catch (error) {
    const createdCount = Pdfium.wasmExports.FPDF_GetPageCount(params.docHandle) - pageCount;
    if (createdCount > 0) _removePages(params.docHandle, pageCount, createdCount);
    throw error;
  }
  const loaded = await _loadPagesInLimitedTimeAsync(params.docHandle, 0, null, null);
  return { pages: loaded.slice(pageCount), pageCount: pageCount + pages.length };
}

/** Creates declarative content pages at the physical end of a live document. */
async function createPagesFromContents(params) {
  const pages = params && params.pages;
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('No page contents provided');
  const pageCount = Pdfium.wasmExports.FPDF_GetPageCount(params.docHandle);
  try {
    _createPagesFromContents(params.docHandle, pageCount, pages);
  } catch (error) {
    const createdCount = Pdfium.wasmExports.FPDF_GetPageCount(params.docHandle) - pageCount;
    if (createdCount > 0) _removePages(params.docHandle, pageCount, createdCount);
    throw error;
  }
  const loaded = await _loadPagesInLimitedTimeAsync(params.docHandle, 0, null, null);
  return { pages: loaded.slice(pageCount), pageCount: pageCount + pages.length };
}

function _createPagesFromContents(docHandle, pageIndex, pages) {
  for (let i = 0; i < pages.length; i++) {
    const spec = pages[i];
    if (!spec || !Number.isFinite(spec.width) || spec.width <= 0 || !Number.isFinite(spec.height) || spec.height <= 0) {
      throw new Error(`Invalid page size at index ${i}`);
    }
    const pageHandle = Pdfium.wasmExports.FPDFPage_New(docHandle, pageIndex + i, spec.width, spec.height);
    if (!pageHandle) throw new Error(`Failed to create PDF page ${i}`);
    try {
      for (const object of spec.objects || []) _insertPageContentObject(docHandle, pageHandle, object);
      if (!Pdfium.wasmExports.FPDFPage_GenerateContent(pageHandle)) {
        throw new Error(`Failed to generate content for page ${i}`);
      }
    } finally {
      Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
    }
  }
}

function _contentColor(color, opacity = 1) {
  if (!color) return null;
  return [color.r, color.g, color.b, Math.round((color.a ?? 255) * opacity)];
}

function _setContentMatrix(object, matrix, x = 0, y = 0) {
  const m = matrix || [1, 0, 0, 1, 0, 0];
  const ptr = Pdfium.wasmExports.malloc(24);
  try {
    new Float32Array(Pdfium.memory.buffer, ptr, 6).set([m[0], m[1], m[2], m[3], m[4] + x, m[5] + y]);
    if (!Pdfium.wasmExports.FPDFPageObj_SetMatrix(object, ptr)) throw new Error('Failed to set content matrix');
  } finally {
    Pdfium.wasmExports.free(ptr);
  }
}

function _insertPageContentObject(docHandle, pageHandle, spec) {
  if (spec.kind === 'path') return _insertPathContent(pageHandle, spec);
  if (spec.kind === 'text') return _insertTextContent(docHandle, pageHandle, spec);
  if (spec.kind === 'image') return _insertImageContent(docHandle, pageHandle, spec);
  throw new Error(`Unknown page content kind: ${spec.kind}`);
}

function _insertPathContent(pageHandle, spec) {
  const w = Pdfium.wasmExports;
  const first = spec.segments && spec.segments.find((segment) => segment.op !== 'close');
  if (!first) throw new Error('Path has no drawable segments');
  const object = w.FPDFPageObj_CreateNewPath(first.x, first.y);
  if (!object) throw new Error('Failed to create path object');
  let inserted = false;
  try {
    let skippedFirst = false;
    for (const segment of spec.segments) {
      if (!skippedFirst && segment === first) {
        skippedFirst = true;
        if (segment.op === 'moveTo') continue;
      }
      if (segment.op === 'moveTo') w.FPDFPath_MoveTo(object, segment.x, segment.y);
      else if (segment.op === 'lineTo') w.FPDFPath_LineTo(object, segment.x, segment.y);
      else if (segment.op === 'cubicTo') w.FPDFPath_BezierTo(object, segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y);
      else if (segment.op === 'close') w.FPDFPath_Close(object);
    }
    const opacity = spec.opacity ?? 1;
    const fill = _contentColor(spec.fill, opacity);
    const stroke = _contentColor(spec.stroke, opacity);
    if (fill) w.FPDFPageObj_SetFillColor(object, ...fill);
    if (stroke) w.FPDFPageObj_SetStrokeColor(object, ...stroke);
    w.FPDFPageObj_SetStrokeWidth(object, Math.max(0, spec.strokeWidth ?? 1));
    w.FPDFPageObj_SetLineCap(object, { butt: 0, round: 1, square: 2 }[spec.lineCap || 'butt']);
    w.FPDFPageObj_SetLineJoin(object, { miter: 0, round: 1, bevel: 2 }[spec.lineJoin || 'miter']);
    w.FPDFPath_SetDrawMode(object, fill ? (spec.fillRule === 'evenodd' ? 2 : 1) : 0, stroke ? 1 : 0);
    if (spec.transform) _setContentMatrix(object, spec.transform);
    w.FPDFPage_InsertObject(pageHandle, object);
    inserted = true;
  } finally {
    if (!inserted) w.FPDFPageObj_Destroy(object);
  }
}

function _insertTextContent(docHandle, pageHandle, spec) {
  const w = Pdfium.wasmExports;
  for (const run of spec.runs || []) {
    if (!run.text) continue;
    const embeddedFont = _loadFreeTextFont(docHandle, run.fontFace);
    let object = 0;
    if (embeddedFont) object = w.FPDFPageObj_CreateTextObj(docHandle, embeddedFont, run.fontSize);
    else {
      const name = StringUtils.allocateUTF8(run.fontFace || 'Helvetica');
      try { object = w.FPDFPageObj_NewTextObj(docHandle, name, run.fontSize); }
      finally { StringUtils.freeUTF8(name); }
    }
    if (!object) throw new Error(`Failed to create text object for ${run.fontFace || 'Helvetica'}`);
    let inserted = false;
    try {
      const value = StringUtils.allocateUTF16(run.text);
      try {
        if (!w.FPDFText_SetText(object, value)) throw new Error('Failed to set text content');
      } finally { StringUtils.freeUTF8(value); }
      const fill = _contentColor(run.fill === undefined ? { r: 0, g: 0, b: 0, a: 255 } : run.fill);
      const stroke = _contentColor(run.stroke);
      if (fill) w.FPDFPageObj_SetFillColor(object, ...fill);
      if (stroke) {
        w.FPDFPageObj_SetStrokeColor(object, ...stroke);
        w.FPDFPageObj_SetStrokeWidth(object, Math.max(0, run.strokeWidth ?? 1));
      }
      w.FPDFTextObj_SetTextRenderMode(object, fill && stroke ? 2 : stroke ? 1 : fill ? 0 : 3);
      _setContentMatrix(object, run.transform, run.x, run.y);
      w.FPDFPage_InsertObject(pageHandle, object);
      inserted = true;
    } finally {
      if (!inserted) w.FPDFPageObj_Destroy(object);
    }
  }
  for (const emoji of spec.emojiRuns || []) {
    _insertImageContent(docHandle, pageHandle, {
      kind: 'image',
      source: {
        kind: 'pixels',
        pixels: emoji.pixels,
        pixelWidth: emoji.pixelWidth || emoji.width,
        pixelHeight: emoji.pixelHeight || emoji.height,
        format: 'rgba8888',
      },
      transform: [emoji.width, 0, 0, emoji.height, emoji.x, emoji.y],
    });
  }
}

function _insertImageContent(docHandle, pageHandle, spec) {
  const w = Pdfium.wasmExports;
  const object = w.FPDFPageObj_NewImageObj(docHandle);
  if (!object) throw new Error('Failed to create image object');
  let inserted = false;
  try {
    if (spec.source.kind === 'jpeg') _loadJpegIntoImageObj(pageHandle, object, spec.source.data);
    else _setImageObjPixels(pageHandle, object, spec.source.pixels, spec.source.pixelWidth, spec.source.pixelHeight, spec.source.format, spec.opacity ?? 1);
    _setContentMatrix(object, spec.transform);
    w.FPDFPage_InsertObject(pageHandle, object);
    inserted = true;
  } finally {
    if (!inserted) w.FPDFPageObj_Destroy(object);
  }
}

/**
 * Adds one image page to a document at the given index. Throws on failure; the
 * caller is responsible for closing the document.
 * @param {number} docHandle Document handle
 * @param {number} index 0-based page index
 * @param {Object} page Page spec (see {@link createPagesFromImages})
 */
function _addImagePage(docHandle, index, page) {
  const width = page && page.width;
  const height = page && page.height;
  if (typeof width !== 'number' || width <= 0 || typeof height !== 'number' || height <= 0) {
    throw new Error('Invalid page size');
  }

  const pageHandle = Pdfium.wasmExports.FPDFPage_New(docHandle, index, width, height);
  if (!pageHandle) throw new Error('Failed to create PDF page');

  try {
    const imageObj = Pdfium.wasmExports.FPDFPageObj_NewImageObj(docHandle);
    if (!imageObj) throw new Error('Failed to create image object');

    if (page.kind === 'jpeg') {
      _loadJpegIntoImageObj(pageHandle, imageObj, page.data);
    } else if (page.kind === 'pixels') {
      _setImageObjPixels(pageHandle, imageObj, page.pixels, page.pixelWidth, page.pixelHeight, page.format);
    } else {
      throw new Error('Unknown image page kind');
    }

    // Scale the unit image to fill the page.
    const setMatrixResult = Pdfium.wasmExports.FPDFImageObj_SetMatrix(imageObj, width, 0, 0, height, 0, 0);
    if (!setMatrixResult) throw new Error('Failed to set image matrix');

    Pdfium.wasmExports.FPDFPage_InsertObject(pageHandle, imageObj);

    if (!Pdfium.wasmExports.FPDFPage_GenerateContent(pageHandle)) {
      throw new Error('Failed to generate page content');
    }
  } finally {
    // Close the page (transfers ownership of its objects to the document).
    Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
  }
}

/**
 * Loads inline JPEG data into an image object via a temporary FPDF_FILEACCESS.
 * @param {number} pageHandle Page the image belongs to
 * @param {number} imageObj Image object handle
 * @param {ArrayBuffer} jpegData JPEG image data
 */
function _loadJpegIntoImageObj(pageHandle, imageObj, jpegData) {
  if (!(jpegData instanceof ArrayBuffer)) throw new Error('Invalid JPEG data');

  const fileAccessSize = 12; // sizeof(FPDF_FILEACCESS) - 3 pointers (each 4 bytes in wasm32)
  const fileAccessPtr = Pdfium.wasmExports.malloc(fileAccessSize);
  if (!fileAccessPtr) throw new Error('Failed to allocate file access structure');

  let callbackIndex = -1;
  let pageArrayPtr = 0;
  try {
    const getBlockCallback = (param, position, pBuf, size) => {
      const toCopy = Math.min(size, jpegData.byteLength - position);
      const src = new Uint8Array(jpegData, position, toCopy);
      const dst = new Uint8Array(Pdfium.memory.buffer, pBuf, toCopy);
      dst.set(src);
      return toCopy;
    };
    callbackIndex = Pdfium.addFunction(getBlockCallback, 'iiiii');

    // Re-view after addFunction, which may have grown (and detached) the memory.
    const fa = new Uint32Array(Pdfium.memory.buffer, fileAccessPtr, fileAccessSize >> 2);
    fa[0] = jpegData.byteLength; // m_FileLen
    fa[1] = callbackIndex; // m_GetBlock function pointer

    pageArrayPtr = Pdfium.wasmExports.malloc(4);
    if (!pageArrayPtr) throw new Error('Failed to allocate page array');
    new Int32Array(Pdfium.memory.buffer, pageArrayPtr, 1)[0] = pageHandle;

    const loadResult = Pdfium.wasmExports.FPDFImageObj_LoadJpegFileInline(pageArrayPtr, 1, imageObj, fileAccessPtr);
    if (!loadResult) throw new Error('Failed to load JPEG data into image object');
  } finally {
    if (pageArrayPtr) Pdfium.wasmExports.free(pageArrayPtr);
    if (callbackIndex >= 0) Pdfium.removeFunction(callbackIndex);
    Pdfium.wasmExports.free(fileAccessPtr);
  }
}

/**
 * Set pixel data for an image object
 * @param {number} pageHandle Page handle
 * @param {number} imageObj Image object handle
 * @param {ArrayBuffer} pixels Packed 32-bit pixel data
 * @param {number} pixelWidth Image width in pixels
 * @param {number} pixelHeight Image height in pixels
 * @param {string} [format] 'rgba8888' or 'bgra8888' (default). PDFium bitmaps are
 *   BGRA, so 'rgba8888' input has its R/B channels swapped while copying.
 * @returns {PdfDocument|PdfError}
 */
function _setImageObjPixels(pageHandle, imageObj, pixels, pixelWidth, pixelHeight, format, opacity = 1) {
  const src = new Uint8Array(pixels);
  const expected = pixelWidth * pixelHeight * 4;
  if (src.byteLength < expected) throw new Error('Pixel buffer smaller than width*height*4');
  const pixelDataPtr = Pdfium.wasmExports.malloc(src.byteLength);
  if (!pixelDataPtr) throw new Error('Failed to allocate memory for image pixels');
  const dst = new Uint8Array(Pdfium.memory.buffer, pixelDataPtr, src.byteLength);
  if (format === 'rgba8888') {
    for (let i = 0; i + 3 < src.byteLength; i += 4) {
      dst[i] = src[i + 2]; // B
      dst[i + 1] = src[i + 1]; // G
      dst[i + 2] = src[i]; // R
      dst[i + 3] = Math.round(src[i + 3] * opacity); // A
    }
  } else {
    dst.set(src);
    if (opacity !== 1) {
      for (let i = 3; i < src.byteLength; i += 4) dst[i] = Math.round(dst[i] * opacity);
    }
  }
  const FPDFBitmap_BGRA = 4;
  const bitmapHandle = Pdfium.wasmExports.FPDFBitmap_CreateEx(
    pixelWidth,
    pixelHeight,
    FPDFBitmap_BGRA,
    pixelDataPtr,
    pixelWidth * 4
  );
  if (!bitmapHandle) {
    Pdfium.wasmExports.free(pixelDataPtr);
    throw new Error('Failed to create bitmap for image object');
  }
  const pageArrayPtr = Pdfium.wasmExports.malloc(4); // Allocate space for one pointer
  new Int32Array(Pdfium.memory.buffer, pageArrayPtr, 1)[0] = pageHandle;
  const result = Pdfium.wasmExports.FPDFImageObj_SetBitmap(pageArrayPtr, 1, imageObj, bitmapHandle);
  Pdfium.wasmExports.free(pageArrayPtr);
  Pdfium.wasmExports.free(pixelDataPtr);
  Pdfium.wasmExports.FPDFBitmap_Destroy(bitmapHandle);
  if (!result) {
    throw new Error('Failed to set bitmap for image object');
  }
}

// [pdfrx_web: form support — reapplied by scripts/sync-assets.mjs] {
const FPDF_ANNOT_WIDGET = 20;
const FPDF_FORMFIELD_PUSHBUTTON = 1;
const FPDF_FORMFIELD_CHECKBOX = 2;
const FPDF_FORMFIELD_RADIOBUTTON = 3;
const FPDF_FORMFIELD_COMBOBOX = 4;
const FPDF_FORMFIELD_LISTBOX = 5;
const FPDF_FORMFIELD_TEXTFIELD = 6;

/**
 * Reads a UTF-16LE string out of one of the `FPDFAnnot_Get*` byte-length APIs
 * (buffer=null, buflen=0 -> required byte count incl. the trailing NUL).
 * @param {(...args: number[]) => number} getFn
 * @param {number} formHandle
 * @param {number} annot
 * @param {number[]} extra extra args placed before (buffer, buflen)
 * @returns {string}
 */
function _getFormString(getFn, formHandle, annot, extra = []) {
  const len = getFn(formHandle, annot, ...extra, 0, 0);
  if (len <= 2) return '';
  const buf = Pdfium.wasmExports.malloc(len);
  try {
    getFn(formHandle, annot, ...extra, buf, len);
    return StringUtils.utf16BytesToString(new Uint8Array(Pdfium.memory.buffer, buf, len));
  } finally {
    Pdfium.wasmExports.free(buf);
  }
}

/**
 * @param {number} annot
 * @returns {[number, number, number, number]} normalized page-coord rect [l, top, r, bottom] (top>=bottom)
 */
function _getWidgetRect(annot) {
  const rectF = Pdfium.wasmExports.malloc(4 * 4);
  try {
    Pdfium.wasmExports.FPDFAnnot_GetRect(annot, rectF);
    const [l, t, r, b] = new Float32Array(Pdfium.memory.buffer, rectF, 4);
    return [l, t > b ? t : b, r, t > b ? b : t];
  } finally {
    Pdfium.wasmExports.free(rectF);
  }
}

/**
 * @param {number} pageHandle
 * @param {(annot: number) => void} cb invoked per Widget annotation (annot handle valid only during the call)
 */
function _forEachWidget(pageHandle, cb) {
  const count = Pdfium.wasmExports.FPDFPage_GetAnnotCount(pageHandle);
  for (let i = 0; i < count; i++) {
    const annot = Pdfium.wasmExports.FPDFPage_GetAnnot(pageHandle, i);
    if (!annot) continue;
    try {
      if (Pdfium.wasmExports.FPDFAnnot_GetSubtype(annot) === FPDF_ANNOT_WIDGET) cb(annot);
    } finally {
      Pdfium.wasmExports.FPDFPage_CloseAnnot(annot);
    }
  }
}

/**
 * @param {number} formHandle
 * @param {number} annot Widget annotation
 * @returns {object} WireFormField
 */
function _readWidgetField(formHandle, annot) {
  const w = Pdfium.wasmExports;
  const fieldType = w.FPDFAnnot_GetFormFieldType(formHandle, annot);
  const field = {
    name: _getFormString(w.FPDFAnnot_GetFormFieldName, formHandle, annot),
    fieldType,
    flags: w.FPDFAnnot_GetFormFieldFlags(formHandle, annot),
    rect: _getWidgetRect(annot),
    textOrientation: _readTextOrientation(annot),
    value: _getFormString(w.FPDFAnnot_GetFormFieldValue, formHandle, annot),
    alternateName: _getFormString(w.FPDFAnnot_GetFormFieldAlternateName, formHandle, annot),
  };
  if (fieldType === FPDF_FORMFIELD_CHECKBOX || fieldType === FPDF_FORMFIELD_RADIOBUTTON) {
    field.isChecked = !!w.FPDFAnnot_IsChecked(formHandle, annot);
    field.exportValue = _getFormString(w.FPDFAnnot_GetFormFieldExportValue, formHandle, annot);
  } else if (fieldType === FPDF_FORMFIELD_COMBOBOX || fieldType === FPDF_FORMFIELD_LISTBOX) {
    const optionCount = w.FPDFAnnot_GetOptionCount(formHandle, annot);
    const options = [];
    for (let i = 0; i < optionCount; i++) {
      options.push({
        label: _getFormString(w.FPDFAnnot_GetOptionLabel, formHandle, annot, [i]),
        selected: !!w.FPDFAnnot_IsOptionSelected(formHandle, annot, i),
      });
    }
    field.options = options;
  }
  return field;
}

/** Reads pdfrx text orientation metadata, defaulting older PDFs to page-relative text. */
function _readTextOrientation(annot) {
  const value = _getAnnotField('pdfrx:TextOrientation', annot);
  if (!value) return { rotation: 0, behavior: 'page' };
  try {
    const parsed = JSON.parse(value);
    const rotation = parsed.rotation === 90 || parsed.rotation === 180 || parsed.rotation === 270 ? parsed.rotation : 0;
    return { rotation, behavior: parsed.behavior === 'upright' ? 'upright' : 'page' };
  } catch {
    return { rotation: 0, behavior: 'page' };
  }
}

/**
 * @param {{docHandle: number, formHandle: number, pageIndex: number}} params
 * @returns {{fields: object[]}}
 */
function loadFormFields(params) {
  const { docHandle, formHandle, pageIndex } = params;
  const readWidgets = (pageHandle) => {
    const fields = [];
    _forEachWidget(pageHandle, (annot) => fields.push(_readWidgetField(formHandle, annot)));
    return { fields };
  };
  // Button state reads (FPDFAnnot_IsChecked / GetFormFieldExportValue) are only
  // correct while the page is loaded into the form-fill module, so bracket the
  // enumeration with FORM_OnAfterLoadPage / FORM_OnBeforeClosePage (or reuse an
  // already-open interactive page).
  const ctx = _formCtxByDoc(docHandle);
  if (ctx && formHandle) return _withFormPage(ctx, formHandle, pageIndex, readWidgets);
  const pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, pageIndex);
  if (!pageHandle) throw new Error(`Failed to load page ${pageIndex}`);
  try {
    return readWidgets(pageHandle);
  } finally {
    Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
  }
}

/**
 * Reads the calculate-action (`/AA/C`) JavaScript of every named form field, so
 * the client can run a JS-free calculation shim (this PDFium build has no JS
 * engine). Deduped by field name.
 * @param {{docHandle: number, formHandle: number, pageCount: number}} params
 * @returns {{calculations: {name: string, js: string}[]}}
 */
function loadFormCalculations(params) {
  const { docHandle, formHandle, pageCount } = params;
  const w = Pdfium.wasmExports;
  const FPDF_ANNOT_AACTION_CALCULATE = 15;
  const seen = new Set();
  const calculations = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const pageHandle = w.FPDF_LoadPage(docHandle, pageIndex);
    if (!pageHandle) continue;
    try {
      _forEachWidget(pageHandle, (annot) => {
        const name = _getFormString(w.FPDFAnnot_GetFormFieldName, formHandle, annot);
        if (!name || seen.has(name)) return;
        const js = _getFormString(w.FPDFAnnot_GetFormAdditionalActionJavaScript, formHandle, annot, [
          FPDF_ANNOT_AACTION_CALCULATE,
        ]);
        if (js) {
          seen.add(name);
          calculations.push({ name, js });
        }
      });
    } finally {
      w.FPDF_ClosePage(pageHandle);
    }
  }
  return { calculations };
}

/**
 * Runs `fn` with an interactive page handle for `pageIndex`, reusing an already
 * open one or opening (and closing) a temporary one bracketed by
 * FORM_OnAfterLoadPage / FORM_OnBeforeClosePage.
 * @param {FormContext} ctx
 * @param {number} formHandle
 * @param {number} pageIndex
 * @param {(pageHandle: number) => any} fn
 */
function _withFormPage(ctx, formHandle, pageIndex, fn) {
  let pageHandle = ctx.openPages.get(pageIndex);
  const prevCurrent = ctx.currentPageHandle;
  let opened = false;
  if (!pageHandle) {
    pageHandle = Pdfium.wasmExports.FPDF_LoadPage(ctx.docHandle, pageIndex);
    if (!pageHandle) throw new Error(`Failed to load page ${pageIndex}`);
    Pdfium.wasmExports.FORM_OnAfterLoadPage(pageHandle, formHandle);
    ctx.openPages.set(pageIndex, pageHandle);
    ctx.handleToIndex.set(pageHandle, pageIndex);
    opened = true;
  }
  ctx.currentPageHandle = pageHandle;
  try {
    return fn(pageHandle);
  } finally {
    if (opened) {
      Pdfium.wasmExports.FORM_OnBeforeClosePage(pageHandle, formHandle);
      Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
      ctx.openPages.delete(pageIndex);
      ctx.handleToIndex.delete(pageHandle);
      ctx.currentPageHandle = prevCurrent;
    }
  }
}

/**
 * @param {string|undefined} v
 * @returns {boolean}
 */
function _truthyFormValue(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== 'off' && s !== 'false' && s !== '0' && s !== 'no';
}

/**
 * Sets a form field's value through the form-fill module (which regenerates the
 * widget appearance and fires FFI_OnChange), matched by fully-qualified name.
 * @param {{docHandle: number, formHandle: number, pageIndex: number, fieldName: string,
 *          value?: string, checked?: boolean, selectedLabels?: string[]}} params
 * @returns {{ok: boolean}}
 */
function setFormFieldValue(params) {
  const { docHandle, formHandle, pageIndex, fieldName } = params;
  const ctx = _formCtxByDoc(docHandle);
  if (!ctx) throw new Error(`No form context for document ${docHandle}`);
  const w = Pdfium.wasmExports;

  return _withFormPage(ctx, formHandle, pageIndex, (pageHandle) => {
    // Gather this page's widgets that belong to the named field. Annot handles
    // must stay valid past the enumeration, so capture the ones we need.
    /** @type {{fieldType: number, exportValue: string, rect: number[], index: number}[]} */
    const matches = [];
    let annotIndex = -1;
    _forEachWidget(pageHandle, (annot) => {
      annotIndex++;
      if (_getFormString(w.FPDFAnnot_GetFormFieldName, formHandle, annot) !== fieldName) return;
      const fieldType = w.FPDFAnnot_GetFormFieldType(formHandle, annot);
      const exportValue =
        fieldType === FPDF_FORMFIELD_CHECKBOX || fieldType === FPDF_FORMFIELD_RADIOBUTTON
          ? _getFormString(w.FPDFAnnot_GetFormFieldExportValue, formHandle, annot)
          : '';
      matches.push({ fieldType, exportValue, rect: _getWidgetRect(annot), index: annotIndex });
    });
    if (matches.length === 0) return { ok: false };

    const first = matches[0];
    const clickCenter = (rect) => {
      const cx = (rect[0] + rect[2]) / 2;
      const cy = (rect[1] + rect[3]) / 2;
      w.FORM_OnLButtonDown(formHandle, pageHandle, 0, cx, cy);
      w.FORM_OnLButtonUp(formHandle, pageHandle, 0, cx, cy);
    };
    const focus = (index) => {
      const annot = w.FPDFPage_GetAnnot(pageHandle, index);
      try {
        w.FORM_SetFocusedAnnot(formHandle, annot);
      } finally {
        w.FPDFPage_CloseAnnot(annot);
      }
    };
    const replaceText = (index, text) => {
      focus(index);
      w.FORM_SelectAllText(formHandle, pageHandle);
      const ptr = StringUtils.allocateUTF16(text ?? '');
      try {
        w.FORM_ReplaceSelection(formHandle, pageHandle, ptr);
      } finally {
        StringUtils.freeUTF8(ptr);
      }
    };

    switch (first.fieldType) {
      case FPDF_FORMFIELD_TEXTFIELD:
        replaceText(first.index, params.value);
        break;
      case FPDF_FORMFIELD_CHECKBOX: {
        const desired = params.checked ?? _truthyFormValue(params.value);
        const annot = w.FPDFPage_GetAnnot(pageHandle, first.index);
        const isChecked = !!w.FPDFAnnot_IsChecked(formHandle, annot);
        w.FPDFPage_CloseAnnot(annot);
        if (isChecked !== desired) clickCenter(first.rect);
        break;
      }
      case FPDF_FORMFIELD_RADIOBUTTON: {
        const target = matches.find((m) => m.exportValue === params.value) ?? first;
        clickCenter(target.rect);
        break;
      }
      case FPDF_FORMFIELD_COMBOBOX:
      case FPDF_FORMFIELD_LISTBOX: {
        focus(first.index);
        const annot = w.FPDFPage_GetAnnot(pageHandle, first.index);
        try {
          const count = w.FPDFAnnot_GetOptionCount(formHandle, annot);
          const wanted =
            params.selectedLabels && params.selectedLabels.length
              ? params.selectedLabels
              : params.value != null
                ? [params.value]
                : [];
          if (wanted.length === 0 && first.fieldType === FPDF_FORMFIELD_COMBOBOX) {
            // Editable combo box: no matching option, treat as free text.
            replaceText(first.index, params.value);
            break;
          }
          let matchedAny = false;
          for (let i = 0; i < count; i++) {
            const label = _getFormString(w.FPDFAnnot_GetOptionLabel, formHandle, annot, [i]);
            const selected = wanted.includes(label);
            if (selected) matchedAny = true;
            w.FORM_SetIndexSelected(formHandle, pageHandle, i, selected);
          }
          if (!matchedAny && first.fieldType === FPDF_FORMFIELD_COMBOBOX) {
            replaceText(first.index, params.value);
          }
        } finally {
          w.FPDFPage_CloseAnnot(annot);
        }
        break;
      }
      default:
        return { ok: false };
    }
    return { ok: true };
  });
}

/**
 * @param {{docHandle: number, formHandle: number, pageIndex: number}} params
 * @returns {{pageHandle: number}}
 */
function formOpenPage(params) {
  const { docHandle, formHandle, pageIndex } = params;
  const ctx = _formCtxByDoc(docHandle);
  if (!ctx) throw new Error(`No form context for document ${docHandle}`);
  let pageHandle = ctx.openPages.get(pageIndex);
  if (!pageHandle) {
    pageHandle = Pdfium.wasmExports.FPDF_LoadPage(docHandle, pageIndex);
    if (!pageHandle) throw new Error(`Failed to load page ${pageIndex}`);
    Pdfium.wasmExports.FORM_OnAfterLoadPage(pageHandle, formHandle);
    ctx.openPages.set(pageIndex, pageHandle);
    ctx.handleToIndex.set(pageHandle, pageIndex);
  }
  ctx.currentPageHandle = pageHandle;
  return { pageHandle };
}

/**
 * @param {{docHandle: number, formHandle: number, pageIndex: number}} params
 * @returns {{message: string}}
 */
function formClosePage(params) {
  const { docHandle, formHandle, pageIndex } = params;
  const ctx = _formCtxByDoc(docHandle);
  if (!ctx) return { message: 'no context' };
  const pageHandle = ctx.openPages.get(pageIndex);
  if (pageHandle) {
    Pdfium.wasmExports.FORM_OnBeforeClosePage(pageHandle, formHandle);
    Pdfium.wasmExports.FPDF_ClosePage(pageHandle);
    ctx.openPages.delete(pageIndex);
    ctx.handleToIndex.delete(pageHandle);
    if (ctx.currentPageHandle === pageHandle) ctx.currentPageHandle = 0;
  }
  return { message: 'closed' };
}

/**
 * @param {{docHandle: number, formHandle: number, pageIndex: number, type: string,
 *          x: number, y: number, modifier?: number}} params
 * @returns {{message: string}}
 */
function formPointerEvent(params) {
  const { docHandle, formHandle, pageIndex, type, x, y, modifier = 0 } = params;
  const ctx = _formCtxByDoc(docHandle);
  const pageHandle = ctx && ctx.openPages.get(pageIndex);
  if (!pageHandle) throw new Error(`Form page ${pageIndex} is not open`);
  ctx.currentPageHandle = pageHandle;
  const w = Pdfium.wasmExports;
  switch (type) {
    case 'down':
      w.FORM_OnLButtonDown(formHandle, pageHandle, modifier, x, y);
      break;
    case 'up':
      w.FORM_OnLButtonUp(formHandle, pageHandle, modifier, x, y);
      break;
    case 'move':
      w.FORM_OnMouseMove(formHandle, pageHandle, modifier, x, y);
      break;
    case 'doubleClick':
      w.FORM_OnLButtonDoubleClick(formHandle, pageHandle, modifier, x, y);
      break;
    default:
      throw new Error(`Unknown form pointer event type: ${type}`);
  }
  return { message: 'ok' };
}

/**
 * @param {{docHandle: number, formHandle: number, pageIndex: number, type: string,
 *          code: number, modifier?: number}} params
 * @returns {{message: string}}
 */
function formKeyEvent(params) {
  const { docHandle, formHandle, pageIndex, type, code, modifier = 0 } = params;
  const ctx = _formCtxByDoc(docHandle);
  const pageHandle = ctx && ctx.openPages.get(pageIndex);
  if (!pageHandle) throw new Error(`Form page ${pageIndex} is not open`);
  const w = Pdfium.wasmExports;
  switch (type) {
    case 'char':
      w.FORM_OnChar(formHandle, pageHandle, code, modifier);
      break;
    case 'keyDown':
      w.FORM_OnKeyDown(formHandle, pageHandle, code, modifier);
      break;
    case 'keyUp':
      w.FORM_OnKeyUp(formHandle, pageHandle, code, modifier);
      break;
    default:
      throw new Error(`Unknown form key event type: ${type}`);
  }
  return { message: 'ok' };
}

/**
 * @param {{docHandle: number, formHandle: number}} params
 * @returns {{message: string}}
 */
function formKillFocus(params) {
  Pdfium.wasmExports.FORM_ForceToKillFocus(params.formHandle);
  return { message: 'ok' };
}

/**
 * @param {{docHandle: number, callbackId: number}} params
 * @returns {{message: string}}
 */
function registerFormNotify(params) {
  const ctx = _formCtxByDoc(params.docHandle);
  if (ctx) ctx.notifyCallbackId = params.callbackId;
  return { message: 'ok' };
}
// [pdfrx_web: form support] }

// [pdfrx_web: annotation support — reapplied by scripts/sync-assets.mjs] {

// FPDF_ANNOTATION_SUBTYPE codes -> lowercase wire names.
const ANNOT_SUBTYPE_NAMES = {
  0: 'unknown',
  1: 'text',
  2: 'link',
  3: 'freeText',
  4: 'line',
  5: 'square',
  6: 'circle',
  7: 'polygon',
  8: 'polyline',
  9: 'highlight',
  10: 'underline',
  11: 'squiggly',
  12: 'strikeout',
  13: 'stamp',
  14: 'caret',
  15: 'ink',
  16: 'popup',
  17: 'fileAttachment',
  18: 'sound',
  19: 'movie',
  20: 'widget',
  21: 'screen',
  22: 'printerMark',
  23: 'trapNet',
  24: 'watermark',
  25: 'threeD',
  26: 'richMedia',
  27: 'xfaWidget',
  28: 'redact',
};
const ANNOT_SUBTYPE_CODES = Object.fromEntries(Object.entries(ANNOT_SUBTYPE_NAMES).map(([k, v]) => [v, Number(k)]));

const FPDFANNOT_COLORTYPE_Color = 0;
const FPDFANNOT_COLORTYPE_InteriorColor = 1;
const FPDF_ANNOT_SUBTYPE_LINK = 2;
const FPDF_ANNOT_SUBTYPE_POPUP = 16;

let _annotIdCounter = 0;
/** Generates a document-unique id stored in the annotation's /NM key. */
function _generateAnnotId() {
  return `pdfrx-${Date.now().toString(36)}-${(_annotIdCounter++).toString(36)}`;
}

// Private dict keys mirroring /C and /IC. FPDFAnnot_GetColor refuses to report a
// color once the annotation has an appearance stream (which we always generate),
// so we persist the authored colors here to keep them readable for the overlay.
const ANNOT_COLOR_KEY = 'pdfrx:C';
const ANNOT_INTERIOR_COLOR_KEY = 'pdfrx:IC';
const ANNOT_FONT_FACE_KEY = 'pdfrx:FontFace';
const ANNOT_TEXT_COLOR_KEY = 'pdfrx:TextColor';
const ANNOT_FONT_SIZE_KEY = 'pdfrx:FontSize';
const ANNOT_TEXT_ALIGN_KEY = 'pdfrx:TextAlign';
const ANNOT_TEXT_VERTICAL_ALIGN_KEY = 'pdfrx:TextVerticalAlign';
const ANNOT_ACTOR_ID_KEY = 'pdfrx:ActorId';
const ANNOT_REVISION_KEY = 'pdfrx:Revision';
/** Bitmap backing stores retained until FPDFPage_GenerateContent consumes them. */
let _pendingAnnotImageBitmaps = [];

function _releasePendingAnnotImageBitmaps() {
  const w = Pdfium.wasmExports;
  for (const { bitmap, buffer } of _pendingAnnotImageBitmaps) {
    w.FPDFBitmap_Destroy(bitmap);
    w.free(buffer);
  }
  _pendingAnnotImageBitmaps = [];
}

/** Serializes an RGBA color to the private-key string form, or '' to clear it. */
function _colorToKey(c) {
  return c ? `${c[0]},${c[1]},${c[2]},${c[3] ?? 255}` : '';
}

/** Parses a private-key color string back to [r,g,b,a], or null. */
function _colorFromKey(str) {
  if (!str) return null;
  const parts = str.split(',').map((n) => parseInt(n, 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2], parts.length >= 4 ? parts[3] : 255];
}

/**
 * Reads FPDFAnnot_GetColor into [r,g,b,a] (0-255), or null when the color is unset.
 * @param {number} annot
 * @param {number} colorType FPDFANNOT_COLORTYPE_*
 * @returns {[number, number, number, number] | null}
 */
function _getAnnotColor(annot, colorType) {
  const w = Pdfium.wasmExports;
  const buf = w.malloc(16); // 4 x unsigned int (R, G, B, A)
  try {
    if (!w.FPDFAnnot_GetColor(annot, colorType, buf, buf + 4, buf + 8, buf + 12)) return null;
    const v = new Uint32Array(Pdfium.memory.buffer, buf, 4);
    return [v[0], v[1], v[2], v[3]];
  } finally {
    w.free(buf);
  }
}

/** Border width in points from FPDFAnnot_GetBorder, or 0 when unset. */
function _getAnnotBorderWidth(annot) {
  const w = Pdfium.wasmExports;
  const buf = w.malloc(12); // horizontal radius, vertical radius, border width (floats)
  try {
    if (!w.FPDFAnnot_GetBorder(annot, buf, buf + 4, buf + 8)) return 0;
    return new Float32Array(Pdfium.memory.buffer, buf, 3)[2];
  } finally {
    w.free(buf);
  }
}

/** Ink annotation strokes: an array of flat point lists `[x0, y0, x1, y1, ...]` (raw page coords). */
function _getAnnotInk(annot) {
  const w = Pdfium.wasmExports;
  const pathCount = w.FPDFAnnot_GetInkListCount(annot);
  const strokes = [];
  for (let p = 0; p < pathCount; p++) {
    const n = w.FPDFAnnot_GetInkListPath(annot, p, 0, 0);
    if (n <= 0) continue;
    const buf = w.malloc(n * 8); // n x FS_POINTF
    try {
      w.FPDFAnnot_GetInkListPath(annot, p, buf, n);
      strokes.push(Array.from(new Float32Array(Pdfium.memory.buffer, buf, n * 2)));
    } finally {
      w.free(buf);
    }
  }
  return strokes;
}

/** Text-markup attachment points: an array of 8-number quads (raw page coords). */
function _getAnnotQuads(annot) {
  const w = Pdfium.wasmExports;
  const count = w.FPDFAnnot_CountAttachmentPoints(annot);
  const quads = [];
  const buf = w.malloc(32); // FS_QUADPOINTSF (8 floats)
  try {
    for (let q = 0; q < count; q++) {
      if (!w.FPDFAnnot_GetAttachmentPoints(annot, q, buf)) continue;
      quads.push(Array.from(new Float32Array(Pdfium.memory.buffer, buf, 8)));
    }
  } finally {
    w.free(buf);
  }
  return quads;
}

/** Polygon/polyline vertices as a flat `[x0, y0, x1, y1, ...]` list (raw page coords). */
function _getAnnotVertices(annot) {
  const w = Pdfium.wasmExports;
  const n = w.FPDFAnnot_GetVertices(annot, 0, 0);
  if (n <= 0) return [];
  const buf = w.malloc(n * 8); // n x FS_POINTF
  try {
    w.FPDFAnnot_GetVertices(annot, buf, n);
    return Array.from(new Float32Array(Pdfium.memory.buffer, buf, n * 2));
  } finally {
    w.free(buf);
  }
}

/** Line endpoints `[x1, y1, x2, y2]` (raw page coords), or null when unset. */
function _getAnnotLine(annot) {
  const w = Pdfium.wasmExports;
  const buf = w.malloc(16); // two FS_POINTF
  try {
    if (!w.FPDFAnnot_GetLine(annot, buf, buf + 8)) return null;
    const f = new Float32Array(Pdfium.memory.buffer, buf, 4);
    return [f[0], f[1], f[2], f[3]];
  } finally {
    w.free(buf);
  }
}

function _getPageObjectColor(object, getter) {
  const w = Pdfium.wasmExports;
  const buf = w.malloc(16);
  try {
    if (!getter(object, buf, buf + 4, buf + 8, buf + 12)) return null;
    return Array.from(new Uint32Array(Pdfium.memory.buffer, buf, 4));
  } finally {
    w.free(buf);
  }
}

/** Extracts vector path objects from an annotation's normal appearance. */
function _getAnnotAppearancePaths(annot) {
  const w = Pdfium.wasmExports;
  const paths = [];
  const objectCount = w.FPDFAnnot_GetObjectCount(annot);
  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const object = w.FPDFAnnot_GetObject(annot, objectIndex);
    if (!object || w.FPDFPageObj_GetType(object) !== 2) continue; // FPDF_PAGEOBJ_PATH
    const matrixPtr = w.malloc(24);
    const pointPtr = w.malloc(8);
    const modePtr = w.malloc(8);
    const widthPtr = w.malloc(4);
    try {
      const matrix = w.FPDFPageObj_GetMatrix(object, matrixPtr)
        ? Array.from(new Float32Array(Pdfium.memory.buffer, matrixPtr, 6))
        : [1, 0, 0, 1, 0, 0];
      const [a, b, c, d, e, f] = matrix;
      const segments = [];
      const count = w.FPDFPath_CountSegments(object);
      for (let i = 0; i < count; i++) {
        const segment = w.FPDFPath_GetPathSegment(object, i);
        if (!segment || !w.FPDFPathSegment_GetPoint(segment, pointPtr, pointPtr + 4)) continue;
        const point = new Float32Array(Pdfium.memory.buffer, pointPtr, 2);
        segments.push([
          w.FPDFPathSegment_GetType(segment),
          a * point[0] + c * point[1] + e,
          b * point[0] + d * point[1] + f,
          w.FPDFPathSegment_GetClose(segment) ? 1 : 0,
        ]);
      }
      new Int32Array(Pdfium.memory.buffer, modePtr, 2).fill(0);
      w.FPDFPath_GetDrawMode(object, modePtr, modePtr + 4);
      w.FPDFPageObj_GetStrokeWidth(object, widthPtr);
      paths.push({
        segments,
        fillColor: _getPageObjectColor(object, w.FPDFPageObj_GetFillColor),
        strokeColor: _getPageObjectColor(object, w.FPDFPageObj_GetStrokeColor),
        strokeWidth: new Float32Array(Pdfium.memory.buffer, widthPtr, 1)[0],
        fillMode: new Int32Array(Pdfium.memory.buffer, modePtr, 2)[0],
        stroke: !!new Int32Array(Pdfium.memory.buffer, modePtr, 2)[1],
        lineCap: w.FPDFPageObj_GetLineCap(object),
        lineJoin: w.FPDFPageObj_GetLineJoin(object),
      });
    } finally {
      w.free(matrixPtr);
      w.free(pointPtr);
      w.free(modePtr);
      w.free(widthPtr);
    }
  }
  return paths;
}

function _getAnnotAppearanceTextStyles(annot) {
  const w = Pdfium.wasmExports;
  const styles = [];
  const objectCount = w.FPDFAnnot_GetObjectCount(annot);
  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const object = w.FPDFAnnot_GetObject(annot, objectIndex);
    if (!object || w.FPDFPageObj_GetType(object) !== 1) continue; // FPDF_PAGEOBJ_TEXT
    const matrixPtr = w.malloc(24);
    try {
      const matrix = w.FPDFPageObj_GetMatrix(object, matrixPtr)
        ? new Float32Array(Pdfium.memory.buffer, matrixPtr, 6)
        : null;
      styles.push({
        x: matrix?.[4] ?? 0,
        y: matrix?.[5] ?? 0,
        fontSize: w.FPDFTextObj_GetFontSize(object),
        fillColor: _getPageObjectColor(object, w.FPDFPageObj_GetFillColor),
      });
    } finally {
      w.free(matrixPtr);
    }
  }
  return styles;
}

/** Extracts the first image object in an annotation appearance as RGBA pixels. */
function _getAnnotAppearanceImage(annot, docHandle, pageHandle) {
  const w = Pdfium.wasmExports;
  const objectCount = w.FPDFAnnot_GetObjectCount(annot);
  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const object = w.FPDFAnnot_GetObject(annot, objectIndex);
    if (!object || w.FPDFPageObj_GetType(object) !== 3) continue; // FPDF_PAGEOBJ_IMAGE
    // Prefer the image object's intrinsic bitmap. GetRenderedBitmap applies
    // the object's placement matrix and can return pixels at the annotation's
    // current on-page size; feeding those pixels back during a later resize
    // causes an immediate resolution drop and then progressive resampling.
    const bitmap =
      w.FPDFImageObj_GetBitmap(object) ||
      w.FPDFImageObj_GetRenderedBitmap(docHandle, pageHandle, object);
    if (!bitmap) continue;
    try {
      const width = w.FPDFBitmap_GetWidth(bitmap);
      const height = w.FPDFBitmap_GetHeight(bitmap);
      const stride = w.FPDFBitmap_GetStride(bitmap);
      const format = w.FPDFBitmap_GetFormat(bitmap);
      const buffer = w.FPDFBitmap_GetBuffer(bitmap);
      if (width <= 0 || height <= 0 || !buffer) continue;
      const source = new Uint8Array(Pdfium.memory.buffer, buffer, stride * height);
      const pixels = new Uint8Array(width * height * 4);
      const bytesPerPixel = format === 1 ? 1 : format === 2 ? 3 : 4;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const src = y * stride + x * bytesPerPixel;
          const dst = (y * width + x) * 4;
          if (format === 1) {
            pixels[dst] = pixels[dst + 1] = pixels[dst + 2] = source[src];
          } else {
            pixels[dst] = source[src + 2];
            pixels[dst + 1] = source[src + 1];
            pixels[dst + 2] = source[src];
          }
          pixels[dst + 3] = format === 4 ? source[src + 3] : 255;
        }
      }
      return { width, height, pixels };
    } finally {
      w.FPDFBitmap_Destroy(bitmap);
    }
  }
  return null;
}

/** Subtype-specific geometry object for the wire. */
function _getAnnotGeometry(annot, subtypeName) {
  switch (subtypeName) {
    case 'ink':
      return { kind: 'ink', strokes: _getAnnotInk(annot) };
    case 'highlight':
    case 'underline':
    case 'squiggly':
    case 'strikeout':
      return { kind: 'markup', quads: _getAnnotQuads(annot) };
    case 'line': {
      const line = _getAnnotLine(annot);
      return line ? { kind: 'line', line } : { kind: 'none' };
    }
    case 'polygon':
    case 'polyline':
      return { kind: subtypeName, vertices: _getAnnotVertices(annot) };
    default:
      return { kind: 'none' };
  }
}

/**
 * @param {number} annot
 * @param {number} index page-local annotation index (used for the fallback id)
 * @returns {object} WireAnnotationObject
 */
function _readAnnotationObject(annot, index, docHandle, pageHandle) {
  const w = Pdfium.wasmExports;
  const subtype = ANNOT_SUBTYPE_NAMES[w.FPDFAnnot_GetSubtype(annot)] ?? 'unknown';
  const content = _getAnnotationContent(annot);
  const nm = _getAnnotField('NM', annot);
  return {
    id: nm || `@${index}`,
    subtype,
    index,
    rect: _getWidgetRect(annot),
    color: _colorFromKey(_getAnnotField(ANNOT_COLOR_KEY, annot)) ?? _getAnnotColor(annot, FPDFANNOT_COLORTYPE_Color),
    interiorColor:
      _colorFromKey(_getAnnotField(ANNOT_INTERIOR_COLOR_KEY, annot)) ??
      _getAnnotColor(annot, FPDFANNOT_COLORTYPE_InteriorColor),
    borderWidth: _getAnnotBorderWidth(annot),
    flags: w.FPDFAnnot_GetFlags(annot),
    contents: content ? content.content : null,
    author: content ? content.title : null,
    actorId: _getAnnotField(ANNOT_ACTOR_ID_KEY, annot) || null,
    revision: Number.parseInt(_getAnnotField(ANNOT_REVISION_KEY, annot), 10) || 0,
    textOrientation: _readTextOrientation(annot),
    textColor: _colorFromKey(_getAnnotField(ANNOT_TEXT_COLOR_KEY, annot)) ?? null,
    fontSize: (() => {
      const value = Number.parseFloat(_getAnnotField(ANNOT_FONT_SIZE_KEY, annot));
      return Number.isFinite(value) && value > 0 ? value : null;
    })(),
    textAlign: ['left', 'center', 'right'].includes(_getAnnotField(ANNOT_TEXT_ALIGN_KEY, annot))
      ? _getAnnotField(ANNOT_TEXT_ALIGN_KEY, annot)
      : 'left',
    textVerticalAlign: ['top', 'middle', 'bottom'].includes(_getAnnotField(ANNOT_TEXT_VERTICAL_ALIGN_KEY, annot))
      ? _getAnnotField(ANNOT_TEXT_VERTICAL_ALIGN_KEY, annot)
      : 'top',
    fontFace: _getAnnotField(ANNOT_FONT_FACE_KEY, annot) || null,
    appearanceLines: (() => {
      const value = _getAnnotField('pdfrx:FreeTextLines', annot);
      if (!value) return null;
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })(),
    appearanceRuns: (() => {
      const value = _getAnnotField('pdfrx:FreeTextRuns', annot);
      if (!value) return null;
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })(),
    appearanceImage: _getAnnotAppearanceImage(annot, docHandle, pageHandle),
    appearancePaths: _getAnnotAppearancePaths(annot),
    appearanceTextStyles: _getAnnotAppearanceTextStyles(annot),
    subject: content ? content.subject : null,
    modificationDate: content ? content.modificationDate : null,
    creationDate: content ? content.creationDate : null,
    geometry: _getAnnotGeometry(annot, subtype),
  };
}

/**
 * Enumerates the content annotations on one page (skips widgets, links and
 * popups — those are surfaced through the form and link paths).
 * @param {{docHandle: number, pageIndex: number}} params
 * @returns {{annotations: object[]}}
 */
function loadAnnotations(params) {
  const { docHandle, pageIndex } = params;
  const w = Pdfium.wasmExports;
  const pageHandle = w.FPDF_LoadPage(docHandle, pageIndex);
  if (!pageHandle) return { annotations: [] };
  try {
    const count = w.FPDFPage_GetAnnotCount(pageHandle);
    const annotations = [];
    for (let i = 0; i < count; i++) {
      const annot = w.FPDFPage_GetAnnot(pageHandle, i);
      if (!annot) continue;
      try {
        const subtype = w.FPDFAnnot_GetSubtype(annot);
        if (subtype === FPDF_ANNOT_WIDGET || subtype === FPDF_ANNOT_SUBTYPE_LINK || subtype === FPDF_ANNOT_SUBTYPE_POPUP)
          continue;
        if (_getAnnotField('pdfrx:FreeTextAppearance', annot)) continue;
        annotations.push(_readAnnotationObject(annot, i, docHandle, pageHandle));
      } finally {
        w.FPDFPage_CloseAnnot(annot);
      }
    }
    return { annotations };
  } finally {
    w.FPDF_ClosePage(pageHandle);
  }
}

/** Sets a UTF-16 string dict value on an annotation (e.g. Contents, T, NM). */
function _setAnnotStringKey(annot, key, value) {
  const w = Pdfium.wasmExports;
  const keyPtr = StringUtils.allocateUTF8(key);
  const valPtr = StringUtils.allocateUTF16(value ?? '');
  try {
    w.FPDFAnnot_SetStringValue(annot, keyPtr, valPtr);
  } finally {
    StringUtils.freeUTF8(keyPtr);
    StringUtils.freeUTF8(valPtr);
  }
}

/**
 * Writes an annotation spec's attributes/geometry onto a freshly created annot.
 * Only the natively-creatable geometries are honored: `ink` (also how the viewer
 * realizes line/arrow), `markup` (attachment points) and rect-defined
 * square/circle. Colors/border/flags/text apply to every subtype.
 */
function _applyAnnotSpec(annot, spec, docHandle) {
  const w = Pdfium.wasmExports;
  if (spec.rect) {
    const buf = w.malloc(16);
    new Float32Array(Pdfium.memory.buffer, buf, 4).set(spec.rect);
    w.FPDFAnnot_SetRect(annot, buf);
    w.free(buf);
  }
  if (spec.color) {
    const c = spec.color;
    w.FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color, c[0], c[1], c[2], c[3] ?? 255);
    _setAnnotStringKey(annot, ANNOT_COLOR_KEY, _colorToKey(c));
  }
  if (spec.interiorColor) {
    const c = spec.interiorColor;
    w.FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_InteriorColor, c[0], c[1], c[2], c[3] ?? 255);
    _setAnnotStringKey(annot, ANNOT_INTERIOR_COLOR_KEY, _colorToKey(c));
  }
  if (typeof spec.borderWidth === 'number') w.FPDFAnnot_SetBorder(annot, 0, 0, spec.borderWidth);
  if (typeof spec.flags === 'number' || spec.textOrientation?.behavior === 'upright') {
    const flags = (spec.flags ?? w.FPDFAnnot_GetFlags(annot)) |
      (spec.textOrientation?.behavior === 'upright' ? 16 : 0); // FPDF_ANNOT_FLAG_NOROTATE
    w.FPDFAnnot_SetFlags(annot, flags);
  }
  if (spec.contents != null) _setAnnotStringKey(annot, 'Contents', spec.contents);
  if (spec.author != null) _setAnnotStringKey(annot, 'T', spec.author);
  if (spec.actorId != null) _setAnnotStringKey(annot, ANNOT_ACTOR_ID_KEY, spec.actorId);
  _setAnnotStringKey(annot, ANNOT_REVISION_KEY, String(spec.revision ?? 1));
  if (spec.textOrientation) {
    _setAnnotStringKey(annot, 'pdfrx:TextOrientation', JSON.stringify(spec.textOrientation));
  }
  if (spec.textColor) _setAnnotStringKey(annot, ANNOT_TEXT_COLOR_KEY, _colorToKey(spec.textColor));
  if (typeof spec.fontSize === 'number') _setAnnotStringKey(annot, ANNOT_FONT_SIZE_KEY, String(spec.fontSize));
  if (spec.textAlign) _setAnnotStringKey(annot, ANNOT_TEXT_ALIGN_KEY, spec.textAlign);
  if (spec.textVerticalAlign) _setAnnotStringKey(annot, ANNOT_TEXT_VERTICAL_ALIGN_KEY, spec.textVerticalAlign);
  if (spec.fontFace != null) _setAnnotStringKey(annot, ANNOT_FONT_FACE_KEY, spec.fontFace);
  if (spec.appearanceLines) _setAnnotStringKey(annot, 'pdfrx:FreeTextLines', JSON.stringify(spec.appearanceLines));
  if (spec.appearanceRuns) {
    const persistedRuns = spec.appearanceRuns.map((line) =>
      line.map((run) => ({ text: run.text, fontFace: run.fontFace, x: run.x })),
    );
    _setAnnotStringKey(annot, 'pdfrx:FreeTextRuns', JSON.stringify(persistedRuns));
  }
  const g = spec.geometry;
  if (g && g.kind === 'ink') {
    for (const stroke of g.strokes) {
      if (!stroke || stroke.length < 4) continue;
      const n = stroke.length / 2;
      const buf = w.malloc(n * 8);
      new Float32Array(Pdfium.memory.buffer, buf, n * 2).set(stroke);
      w.FPDFAnnot_AddInkStroke(annot, buf, n);
      w.free(buf);
    }
  } else if (g && g.kind === 'markup') {
    for (const q of g.quads) {
      if (!q || q.length < 8) continue;
      const buf = w.malloc(32);
      new Float32Array(Pdfium.memory.buffer, buf, 8).set(q);
      w.FPDFAnnot_AppendAttachmentPoints(annot, buf);
      w.free(buf);
    }
  }
}

/** @type {Map<number, Map<string, number>>} */
const _freeTextFontsByDocument = new Map();

function _loadFreeTextFont(docHandle, face) {
  if (!face) return 0;
  let fonts = _freeTextFontsByDocument.get(docHandle);
  if (!fonts) {
    fonts = new Map();
    _freeTextFontsByDocument.set(docHandle, fonts);
  }
  if (fonts.has(face)) return fonts.get(face);

  const cached = pdfFontMapper?.cachedFontsByFace[face];
  if (!cached?.data) return 0;
  const w = Pdfium.wasmExports;
  const fontPtr = w.malloc(cached.data.byteLength);
  if (!fontPtr) return 0;
  let font = 0;
  try {
    new Uint8Array(Pdfium.memory.buffer, fontPtr, cached.data.byteLength).set(cached.data);
    font = w.FPDFText_LoadFont(docHandle, fontPtr, cached.data.byteLength, 1, face.includes('symbols') ? 0 : 1);
  } finally {
    w.free(fontPtr);
  }
  if (font) fonts.set(face, font);
  return font;
}

function _closeFreeTextFonts(docHandle) {
  const fonts = _freeTextFontsByDocument.get(docHandle);
  if (!fonts) return;
  for (const font of fonts.values()) Pdfium.wasmExports.FPDFFont_Close(font);
  _freeTextFontsByDocument.delete(docHandle);
}

/** Builds a FreeText appearance with independent fill, stroke, and embedded text. */
function _appendFreeTextAppearance(docHandle, pageHandle, annot, spec) {
  const w = Pdfium.wasmExports;
  const rect = spec.rect;
  if (!rect) return;
  const [left, top, right, bottom] = rect;
  const width = Math.max(0, right - left);
  const height = Math.max(0, top - bottom);
  const borderWidth = Math.max(0, spec.borderWidth ?? 0);
  const fill = spec.interiorColor;
  const stroke = spec.color;
  const intrinsicRotation = spec.textOrientation?.rotation ?? 0;
  const centreX = (left + right) / 2;
  const centreY = (top + bottom) / 2;
  const rotatePoint = (x, y) => {
    if (!intrinsicRotation) return [x, y];
    const radians = (-intrinsicRotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = x - centreX;
    const dy = y - centreY;
    return [centreX + cos * dx - sin * dy, centreY + sin * dx + cos * dy];
  };
  if (fill || (stroke && borderWidth > 0)) {
    const path = w.FPDFPageObj_CreateNewRect(left, bottom, width, height);
    if (path) {
      if (fill) w.FPDFPageObj_SetFillColor(path, fill[0], fill[1], fill[2], fill[3] ?? 255);
      if (stroke && borderWidth > 0) {
        w.FPDFPageObj_SetStrokeColor(path, stroke[0], stroke[1], stroke[2], stroke[3] ?? 255);
        w.FPDFPageObj_SetStrokeWidth(path, borderWidth);
      }
      w.FPDFPath_SetDrawMode(path, fill ? 1 : 0, stroke && borderWidth > 0 ? 1 : 0);
      if (!w.FPDFAnnot_AppendObject(annot, path)) w.FPDFPageObj_Destroy(path);
    }
  }
  if (spec.contents) {
    const fontSize = Math.max(1, spec.fontSize ?? 12);
    const textColor = spec.textColor ?? [0, 0, 0, spec.color?.[3] ?? spec.interiorColor?.[3] ?? 255];
    const lineHeight = fontSize * 1.2;
    const lines = spec.appearanceLines ?? String(spec.contents).replace(/\r\n?/g, '\n').split('\n');
    // Reserve a small descent below the final baseline so glyphs such as g/p/y
    // stay inside the annotation clip when bottom-aligned.
    const descent = fontSize * 0.15;
    const contentHeight = lines.length > 0
      ? fontSize + (lines.length - 1) * lineHeight + descent
      : 0;
    const availableHeight = Math.max(0, top - bottom - borderWidth * 2 - 6);
    const verticalOffset = spec.textVerticalAlign === 'bottom'
      ? Math.max(0, availableHeight - contentHeight)
      : spec.textVerticalAlign === 'middle'
        ? Math.max(0, (availableHeight - contentHeight) / 2)
        : 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      const runs = spec.appearanceRuns?.[index] ?? [{ text: line, fontFace: spec.fontFace ?? null, x: 0 }];
      for (const run of runs) {
        if (!run.text) continue;
        if (run.image) {
          _appendFreeTextImage(
            docHandle,
            pageHandle,
            annot,
            run.image,
            left + borderWidth + 3 + (run.x ?? 0),
            top - borderWidth - 3 - verticalOffset - index * lineHeight,
            intrinsicRotation,
            centreX,
            centreY,
          );
          continue;
        }
        const font = _loadFreeTextFont(docHandle, run.fontFace);
        let text = 0;
        if (font) {
          text = w.FPDFPageObj_CreateTextObj(docHandle, font, fontSize);
        } else {
          const name = StringUtils.allocateUTF8('Arial');
          try {
            text = w.FPDFPageObj_NewTextObj(docHandle, name, fontSize);
          } finally {
            StringUtils.freeUTF8(name);
          }
        }
        if (!text) continue;
        const value = StringUtils.allocateUTF16(run.text);
        try {
          if (!w.FPDFText_SetText(text, value)) {
            w.FPDFPageObj_Destroy(text);
            continue;
          }
        } finally {
          StringUtils.freeUTF8(value);
        }
        w.FPDFPageObj_SetFillColor(
          text,
          textColor[0],
          textColor[1],
          textColor[2],
          textColor[3] ?? 255,
        );
        const radians = (-intrinsicRotation * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const position = rotatePoint(
          left + borderWidth + 3 + (run.x ?? 0),
          top - borderWidth - 3 - verticalOffset - fontSize - index * lineHeight,
        );
        w.FPDFPageObj_Transform(text, cos, sin, -sin, cos, position[0], position[1]);
        if (!w.FPDFAnnot_AppendObject(annot, text)) w.FPDFPageObj_Destroy(text);
      }
    }
  }
}

function _appendFreeTextImage(docHandle, pageHandle, annot, image, x, top, rotation = 0, centreX = 0, centreY = 0) {
  const w = Pdfium.wasmExports;
  const stride = image.width * 4;
  const buffer = w.malloc(stride * image.height);
  const target = new Uint8Array(Pdfium.memory.buffer, buffer, stride * image.height);
  // Canvas supplies RGBA; PDFium's bitmap format 4 is BGRA.
  for (let i = 0; i < image.pixels.length; i += 4) {
    target[i] = image.pixels[i + 2];
    target[i + 1] = image.pixels[i + 1];
    target[i + 2] = image.pixels[i];
    target[i + 3] = image.pixels[i + 3];
  }
  const bitmap = w.FPDFBitmap_CreateEx(image.width, image.height, 4, buffer, stride);
  if (!bitmap) {
    w.free(buffer);
    return;
  }
  const object = w.FPDFPageObj_NewImageObj(docHandle);
  const pages = w.malloc(4);
  let appended = false;
  try {
    new Int32Array(Pdfium.memory.buffer, pages, 1)[0] = pageHandle;
    if (!object || !w.FPDFImageObj_SetBitmap(pages, 1, object, bitmap)) {
      if (object) w.FPDFPageObj_Destroy(object);
      return;
    }
    const scale = image.scale || 1;
    const width = image.width / scale;
    const height = image.height / scale;
    const matrix = w.malloc(24);
    try {
      const radians = (-rotation * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const lowerY = top - height;
      const dx = x - centreX;
      const dy = lowerY - centreY;
      const tx = centreX + cos * dx - sin * dy;
      const ty = centreY + sin * dx + cos * dy;
      new Float32Array(Pdfium.memory.buffer, matrix, 6).set([
        width * cos, width * sin, -height * sin, height * cos, tx, ty,
      ]);
      w.FPDFPageObj_SetMatrix(object, matrix);
    } finally {
      w.free(matrix);
    }
    appended = !!w.FPDFAnnot_AppendObject(annot, object);
    if (!appended) w.FPDFPageObj_Destroy(object);
  } finally {
    w.free(pages);
    if (appended) _pendingAnnotImageBitmaps.push({ bitmap, buffer });
    else {
      w.FPDFBitmap_Destroy(bitmap);
      w.free(buffer);
    }
  }
}

/** Appends normalized SVG-style paths to a Stamp annotation appearance. */
function _appendStampPaths(annot, rect, paths) {
  const w = Pdfium.wasmExports;
  const [left, top, right, bottom] = rect;
  const width = Math.max(0.01, right - left);
  const height = Math.max(0.01, top - bottom);
  const point = (segment) => [left + segment[1] * width, bottom + (1 - segment[2]) * height];
  for (const appearance of paths) {
    const segments = appearance.segments;
    const first = segments?.[0];
    if (!first) continue;
    const firstPoint = point(first);
    const object = w.FPDFPageObj_CreateNewPath(firstPoint[0], firstPoint[1]);
    if (!object) continue;
    let appended = false;
    try {
      for (let index = first[0] === 2 ? 1 : 0; index < segments.length; index++) {
        const segment = segments[index];
        if (!segment) continue;
        const p = point(segment);
        if (segment[0] === 2) {
          w.FPDFPath_MoveTo(object, p[0], p[1]);
        } else if (segment[0] === 0) {
          w.FPDFPath_LineTo(object, p[0], p[1]);
        } else {
          const control2 = segments[index + 1];
          const end = segments[index + 2];
          if (!control2 || !end || control2[0] !== 1 || end[0] !== 1) continue;
          const p2 = point(control2);
          const p3 = point(end);
          w.FPDFPath_BezierTo(object, p[0], p[1], p2[0], p2[1], p3[0], p3[1]);
          if (end[3]) w.FPDFPath_Close(object);
          index += 2;
          continue;
        }
        if (segment[3]) w.FPDFPath_Close(object);
      }
      // PDFium may report a default black object color even when that paint
      // operation is disabled. Draw mode is authoritative; otherwise a
      // stroke-only SVG path becomes a black fill after move/resize round-trip.
      const fill = appearance.fillMode ? appearance.fillColor : null;
      const stroke = appearance.stroke ? appearance.strokeColor : null;
      if (fill) w.FPDFPageObj_SetFillColor(object, fill[0], fill[1], fill[2], fill[3] ?? 255);
      if (stroke) {
        w.FPDFPageObj_SetStrokeColor(object, stroke[0], stroke[1], stroke[2], stroke[3] ?? 255);
        w.FPDFPageObj_SetStrokeWidth(object, Math.max(0, appearance.strokeWidth * width));
      }
      w.FPDFPath_SetDrawMode(object, fill ? (appearance.fillMode || 1) : 0, appearance.stroke && !!stroke ? 1 : 0);
      appended = !!w.FPDFAnnot_AppendObject(annot, object);
    } finally {
      if (!appended) w.FPDFPageObj_Destroy(object);
    }
  }
}

/**
 * Forces PDFium to generate (and persist into the annotation dicts) the /AP
 * appearance streams for any annotations on the page that lack them, by drawing
 * the page once into a 1x1 FPDF_ANNOT bitmap. This is what makes freshly created
 * annotations render in third-party viewers after encodePdf (FPDF_SaveAsCopy).
 */
function _forceAnnotAppearances(pageHandle) {
  const w = Pdfium.wasmExports;
  const buf = w.malloc(4);
  try {
    const FPDFBitmap_BGRA = 4;
    const bmp = w.FPDFBitmap_CreateEx(1, 1, FPDFBitmap_BGRA, buf, 4);
    if (bmp) {
      const FPDF_ANNOT = 1;
      w.FPDF_RenderPageBitmap(bmp, pageHandle, 0, 0, 1, 1, 0, FPDF_ANNOT);
      w.FPDFBitmap_Destroy(bmp);
    }
  } finally {
    w.free(buf);
  }
}

/** Page-local index of the annotation with the given id (NM key, or `@<index>`), or -1. */
function _findAnnotIndexById(pageHandle, id) {
  const w = Pdfium.wasmExports;
  if (id && id[0] === '@') {
    const idx = parseInt(id.slice(1), 10);
    return Number.isFinite(idx) ? idx : -1;
  }
  const count = w.FPDFPage_GetAnnotCount(pageHandle);
  for (let i = 0; i < count; i++) {
    const annot = w.FPDFPage_GetAnnot(pageHandle, i);
    if (!annot) continue;
    try {
      if (_getAnnotField('NM', annot) === id) return i;
    } finally {
      w.FPDFPage_CloseAnnot(annot);
    }
  }
  return -1;
}

/** Creates an annotation from `spec` on a live page handle and returns its id. */
function _createAnnotOnPage(docHandle, pageHandle, pageIndex, spec, forcedId) {
  const w = Pdfium.wasmExports;
  const code = ANNOT_SUBTYPE_CODES[spec.subtype];
  if (code == null) throw new Error(`Unsupported annotation subtype: ${spec.subtype}`);
  const annot = w.FPDFPage_CreateAnnot(pageHandle, code);
  if (!annot) throw new Error('FPDFPage_CreateAnnot failed');
  const id = forcedId || spec.id || _generateAnnotId();
  try {
    _setAnnotStringKey(annot, 'NM', id);
    _applyAnnotSpec(annot, spec, docHandle);
    if (spec.subtype === 'stamp' && spec.appearanceImage && spec.rect) {
      const [left, top, right] = spec.rect;
      const image = spec.appearanceImage;
      const scale = image.width / Math.max(0.01, right - left);
      _appendFreeTextImage(docHandle, pageHandle, annot, { ...image, scale }, left, top);
    } else if (spec.subtype === 'stamp' && spec.appearancePaths && spec.rect) {
      _appendStampPaths(annot, spec.rect, spec.appearancePaths);
    }
    // PDFium cannot append page objects to a FreeText /AP. Keep the semantic
    // FreeText annotation hidden and paint its deterministic appearance in an
    // internal companion Stamp annotation instead.
    if (spec.subtype === 'freeText') w.FPDFAnnot_SetFlags(annot, (spec.flags ?? 0) | 32);
  } finally {
    w.FPDFPage_CloseAnnot(annot);
  }
  if (spec.subtype === 'freeText') {
    const stamp = w.FPDFPage_CreateAnnot(pageHandle, ANNOT_SUBTYPE_CODES.stamp);
    if (stamp) {
      try {
        w.FPDFAnnot_SetFlags(stamp, 4);
        _setAnnotStringKey(stamp, 'NM', `${id}:appearance`);
        _setAnnotStringKey(stamp, 'pdfrx:FreeTextAppearance', id);
        if (spec.rect) {
          const buf = w.malloc(16);
          new Float32Array(Pdfium.memory.buffer, buf, 4).set(spec.rect);
          w.FPDFAnnot_SetRect(stamp, buf);
          w.free(buf);
        }
        _appendFreeTextAppearance(docHandle, pageHandle, stamp, spec);
      } finally {
        w.FPDFPage_CloseAnnot(stamp);
      }
    }
  }
  return id;
}

function _removeAnnotById(pageHandle, id) {
  const index = _findAnnotIndexById(pageHandle, id);
  return index >= 0 ? !!Pdfium.wasmExports.FPDFPage_RemoveAnnot(pageHandle, index) : false;
}

/**
 * @param {{docHandle: number, pageIndex: number, spec: object}} params
 * @returns {{id: string}}
 */
function addAnnotation(params) {
  const { docHandle, pageIndex, spec } = params;
  const w = Pdfium.wasmExports;
  const pageHandle = w.FPDF_LoadPage(docHandle, pageIndex);
  if (!pageHandle) throw new Error(`Failed to load page ${pageIndex}`);
  try {
    const id = _createAnnotOnPage(docHandle, pageHandle, pageIndex, spec);
    _forceAnnotAppearances(pageHandle);
    w.FPDFPage_GenerateContent(pageHandle);
    _releasePendingAnnotImageBitmaps();
    return { id, revision: spec.revision ?? 1 };
  } finally {
    _releasePendingAnnotImageBitmaps();
    w.FPDF_ClosePage(pageHandle);
  }
}

/**
 * Replaces the annotation identified by `id` with a fresh one built from `spec`
 * (keeping the same id). Geometry has no in-place PDFium setter, so edit =
 * remove + recreate; the client sends the full new spec.
 * @param {{docHandle: number, pageIndex: number, id: string, spec: object}} params
 * @returns {{id: string}}
 */
function updateAnnotation(params) {
  const { docHandle, pageIndex, id, preserveAppearance = false } = params;
  let { spec } = params;
  const w = Pdfium.wasmExports;
  const pageHandle = w.FPDF_LoadPage(docHandle, pageIndex);
  if (!pageHandle) throw new Error(`Failed to load page ${pageIndex}`);
  try {
    const existingIndex = _findAnnotIndexById(pageHandle, id);
    let existingRevision = 0;
    if (existingIndex >= 0) {
      const existing = w.FPDFPage_GetAnnot(pageHandle, existingIndex);
      if (existing) {
        existingRevision = Number.parseInt(_getAnnotField(ANNOT_REVISION_KEY, existing), 10) || 0;
        if (
          spec.subtype === 'stamp' &&
          ((!spec.appearanceImage && !spec.appearancePaths) || (preserveAppearance && spec.appearanceImage))
        ) {
          const keepsCustomAppearance = preserveAppearance && !!spec.appearanceImage;
          const revision = spec.revision ?? existingRevision + 1;
          spec = { ...spec, revision };
          _applyAnnotSpec(existing, spec, docHandle);
          w.FPDFPage_CloseAnnot(existing);
          // Rendering the page to force PDFium-generated appearances is useful
          // for ordinary stamps, but it may replace a custom raster stamp's /AP.
          // A preserveAppearance update changes metadata/rect in place, so keep
          // that existing image appearance untouched.
          if (!keepsCustomAppearance) _forceAnnotAppearances(pageHandle);
          w.FPDFPage_GenerateContent(pageHandle);
          return { id, revision };
        }
        w.FPDFPage_CloseAnnot(existing);
      }
    }
    const revision = spec.revision ?? existingRevision + 1;
    spec = { ...spec, revision };
    _removeAnnotById(pageHandle, `${id}:appearance`);
    _removeAnnotById(pageHandle, id);
    const newId = _createAnnotOnPage(docHandle, pageHandle, pageIndex, spec, spec.id || id);
    _forceAnnotAppearances(pageHandle);
    w.FPDFPage_GenerateContent(pageHandle);
    _releasePendingAnnotImageBitmaps();
    return { id: newId, revision };
  } finally {
    _releasePendingAnnotImageBitmaps();
    w.FPDF_ClosePage(pageHandle);
  }
}

/**
 * @param {{docHandle: number, pageIndex: number, id: string}} params
 * @returns {{ok: boolean}}
 */
function removeAnnotation(params) {
  const { docHandle, pageIndex, id } = params;
  const w = Pdfium.wasmExports;
  const pageHandle = w.FPDF_LoadPage(docHandle, pageIndex);
  if (!pageHandle) throw new Error(`Failed to load page ${pageIndex}`);
  try {
    _removeAnnotById(pageHandle, `${id}:appearance`);
    const ok = _removeAnnotById(pageHandle, id);
    w.FPDFPage_GenerateContent(pageHandle);
    return { ok };
  } finally {
    w.FPDF_ClosePage(pageHandle);
  }
}
// [pdfrx_web: annotation support] }

// [pdfrx_web: raw PDF object support]
const RAW_OBJECT = {
  UNKNOWN: 0,
  BOOLEAN: 1,
  NUMBER: 2,
  STRING: 3,
  NAME: 4,
  ARRAY: 5,
  DICTIONARY: 6,
  STREAM: 7,
  NULL: 8,
  REFERENCE: 9,
};

const _rawTextEncoder = new TextEncoder();
const _rawTextDecoder = new TextDecoder();

function _rawWithBytes(bytes, callback) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength === 0) return callback(0, 0);
  const ptr = Pdfium.wasmExports.malloc(data.byteLength);
  try {
    new Uint8Array(Pdfium.memory.buffer, ptr, data.byteLength).set(data);
    return callback(ptr, data.byteLength);
  } finally {
    Pdfium.wasmExports.free(ptr);
  }
}

function _rawReadBytes(read) {
  const length = Number(read(0, 0));
  if (length === 0) return new Uint8Array();
  const ptr = Pdfium.wasmExports.malloc(length);
  try {
    if (Number(read(ptr, length)) !== length) throw new Error('Raw PDF byte read changed length');
    return new Uint8Array(Pdfium.memory.buffer, ptr, length).slice();
  } finally {
    Pdfium.wasmExports.free(ptr);
  }
}

function _rawReadString(object) {
  return _rawReadBytes((ptr, length) => Pdfium.wasmExports.FPDFRaw_GetString(object, ptr, length));
}

function _rawDictionaryEntries(dictionary, options) {
  const w = Pdfium.wasmExports;
  const entries = {};
  const count = Number(w.FPDFRaw_DictionaryGetCount(dictionary));
  for (let index = 0; index < count; index++) {
    const keyBytes = _rawReadBytes((ptr, length) => w.FPDFRaw_DictionaryGetKey(dictionary, index, ptr, length));
    const key = _rawTextDecoder.decode(keyBytes);
    const value = _rawWithBytes(keyBytes, (ptr, length) => w.FPDFRaw_DictionaryGet(dictionary, ptr, length));
    if (!value) continue;
    try {
      entries[key] = _rawSerializeObject(value, options);
    } finally {
      w.FPDFRaw_CloseObject(value);
    }
  }
  return entries;
}

function _rawSerializeObject(object, options = {}) {
  const w = Pdfium.wasmExports;
  const type = Number(w.FPDFRaw_GetObjectType(object));
  switch (type) {
    case RAW_OBJECT.NULL:
      return { kind: 'null' };
    case RAW_OBJECT.BOOLEAN:
      return { kind: 'boolean', value: Boolean(w.FPDFRaw_GetBoolean(object)) };
    case RAW_OBJECT.NUMBER: {
      const integer = Number(w.FPDFRaw_GetInteger(object));
      const number = Number(w.FPDFRaw_GetNumber(object));
      return integer === number ? { kind: 'integer', value: integer } : { kind: 'number', value: number };
    }
    case RAW_OBJECT.STRING:
      return { kind: 'string', value: _rawReadString(object) };
    case RAW_OBJECT.NAME:
      return { kind: 'name', value: _rawTextDecoder.decode(_rawReadString(object)) };
    case RAW_OBJECT.REFERENCE:
      return {
        kind: 'reference',
        objectNumber: Number(w.FPDFRaw_GetReferenceObjectNumber(object)),
        generationNumber: Number(w.FPDFRaw_GetGenerationNumber(object)),
      };
    case RAW_OBJECT.ARRAY: {
      const items = [];
      const count = Number(w.FPDFRaw_ArrayGetCount(object));
      for (let index = 0; index < count; index++) {
        const item = w.FPDFRaw_ArrayGet(object, index);
        if (!item) throw new Error(`Could not read raw PDF array item ${index}`);
        try {
          items.push(_rawSerializeObject(item, options));
        } finally {
          w.FPDFRaw_CloseObject(item);
        }
      }
      return { kind: 'array', items };
    }
    case RAW_OBJECT.DICTIONARY:
      return { kind: 'dictionary', entries: _rawDictionaryEntries(object, options) };
    case RAW_OBJECT.STREAM: {
      const dictionary = w.FPDFRaw_StreamGetDictionary(object);
      if (!dictionary) throw new Error('Could not read raw PDF stream dictionary');
      let entries;
      try {
        entries = _rawDictionaryEntries(dictionary, options);
      } finally {
        w.FPDFRaw_CloseObject(dictionary);
      }
      const data = _rawReadBytes((ptr, length) => w.FPDFRaw_StreamGetData(object, ptr, length));
      const rawData = options.includeRawStreamData
        ? _rawReadBytes((ptr, length) => w.FPDFRaw_StreamGetRawData(object, ptr, length))
        : undefined;
      return { kind: 'stream', entries, data, ...(rawData ? { rawData } : {}) };
    }
    default:
      throw new Error(`Unsupported raw PDF object type ${type}`);
  }
}

function rawGetObject(params) {
  const w = Pdfium.wasmExports;
  const object = params.objectNumber === undefined
    ? w.FPDFRaw_GetRoot(params.docHandle)
    : w.FPDFRaw_GetIndirectObject(params.docHandle, params.objectNumber);
  if (!object) return { object: null, objectNumber: params.objectNumber ?? 0, generationNumber: 0 };
  try {
    return {
      object: _rawSerializeObject(object, params),
      objectNumber: Number(w.FPDFRaw_GetObjectNumber(object)),
      generationNumber: Number(w.FPDFRaw_GetGenerationNumber(object)),
    };
  } finally {
    w.FPDFRaw_CloseObject(object);
  }
}

function _rawNewObject(document, value, locals) {
  const w = Pdfium.wasmExports;
  if (value.kind === 'localReference') {
    const objectNumber = locals[value.id];
    if (!objectNumber) throw new Error(`Unknown local raw PDF reference: ${value.id}`);
    return w.FPDFRaw_NewReference(document, objectNumber);
  }
  switch (value.kind) {
    case 'null':
      return w.FPDFRaw_NewNull();
    case 'boolean':
      return w.FPDFRaw_NewBoolean(value.value ? 1 : 0);
    case 'integer':
      return w.FPDFRaw_NewInteger(value.value);
    case 'number':
      return w.FPDFRaw_NewNumber(value.value);
    case 'string':
      return _rawWithBytes(value.value, (ptr, length) => w.FPDFRaw_NewString(ptr, length));
    case 'name': {
      const bytes = _rawTextEncoder.encode(value.value);
      return _rawWithBytes(bytes, (ptr, length) => w.FPDFRaw_NewName(ptr, length));
    }
    case 'reference':
      return w.FPDFRaw_NewReference(document, value.objectNumber);
    case 'array': {
      const array = w.FPDFRaw_NewArray();
      for (const item of value.items) {
        const child = _rawNewObject(document, item, locals);
        try {
          if (!w.FPDFRaw_ArrayAppend(array, child)) throw new Error('Could not append raw PDF array item');
        } finally {
          w.FPDFRaw_CloseObject(child);
        }
      }
      return array;
    }
    case 'dictionary': {
      const dictionary = w.FPDFRaw_NewDictionary();
      for (const [key, childValue] of Object.entries(value.entries)) {
        _rawDictionarySet(document, dictionary, key, childValue, locals);
      }
      return dictionary;
    }
    case 'stream': {
      const stream = _rawWithBytes(value.data, (ptr, length) => w.FPDFRaw_NewStream(ptr, length));
      const dictionary = w.FPDFRaw_StreamGetDictionary(stream);
      if (!dictionary) {
        w.FPDFRaw_CloseObject(stream);
        throw new Error('Could not obtain new raw PDF stream dictionary');
      }
      try {
        for (const [key, childValue] of Object.entries(value.entries)) {
          if (key !== 'Length' && key !== 'Filter' && key !== 'DecodeParms') {
            _rawDictionarySet(document, dictionary, key, childValue, locals);
          }
        }
      } finally {
        w.FPDFRaw_CloseObject(dictionary);
      }
      return stream;
    }
    default:
      throw new Error(`Unsupported raw PDF patch value: ${value.kind}`);
  }
}

function _rawDictionarySet(document, dictionary, key, value, locals) {
  const w = Pdfium.wasmExports;
  const child = _rawNewObject(document, value, locals);
  try {
    const bytes = _rawTextEncoder.encode(key);
    const ok = _rawWithBytes(bytes, (ptr, length) => w.FPDFRaw_DictionarySet(dictionary, ptr, length, child));
    if (!ok) throw new Error(`Could not set raw PDF dictionary key /${key}`);
  } finally {
    w.FPDFRaw_CloseObject(child);
  }
}

function _rawResolveTarget(document, target, locals) {
  const w = Pdfium.wasmExports;
  const handles = [];
  const objectNumber = target.localId ? locals[target.localId] : target.objectNumber;
  let object = target.root ? w.FPDFRaw_GetRoot(document) : w.FPDFRaw_GetIndirectObject(document, objectNumber);
  if (!object) throw new Error('Raw PDF patch target does not exist');
  handles.push(object);
  for (const component of target.path ?? []) {
    let direct = w.FPDFRaw_GetDirectObject(object);
    if (!direct) throw new Error('Could not dereference raw PDF patch path');
    handles.push(direct);
    object = direct;
    let child;
    if (typeof component === 'string') {
      const bytes = _rawTextEncoder.encode(component);
      child = _rawWithBytes(bytes, (ptr, length) => w.FPDFRaw_DictionaryGet(object, ptr, length));
    } else {
      child = w.FPDFRaw_ArrayGet(object, component);
    }
    if (!child) throw new Error(`Raw PDF patch path component does not exist: ${String(component)}`);
    handles.push(child);
    object = child;
  }
  const direct = w.FPDFRaw_GetDirectObject(object);
  if (direct) {
    handles.push(direct);
    object = direct;
  }
  return { object, close: () => handles.reverse().forEach((handle) => w.FPDFRaw_CloseObject(handle)) };
}

function rawApplyPatch(params) {
  const w = Pdfium.wasmExports;
  const locals = {};
  for (const id of params.createDictionaries ?? []) {
    if (locals[id]) throw new Error(`Duplicate local raw PDF object id: ${id}`);
    const dictionary = w.FPDFRaw_NewDictionary();
    try {
      const objectNumber = Number(w.FPDFRaw_AddIndirectObject(params.docHandle, dictionary));
      if (!objectNumber) throw new Error(`Could not create indirect raw PDF dictionary: ${id}`);
      locals[id] = objectNumber;
    } finally {
      w.FPDFRaw_CloseObject(dictionary);
    }
  }
  for (const operation of params.operations) {
    const target = _rawResolveTarget(params.docHandle, operation.target, locals);
    try {
      if (operation.op === 'dictionarySet') {
        _rawDictionarySet(params.docHandle, target.object, operation.key, operation.value, locals);
      } else if (operation.op === 'dictionaryRemove') {
        const bytes = _rawTextEncoder.encode(operation.key);
        _rawWithBytes(bytes, (ptr, length) => w.FPDFRaw_DictionaryRemove(target.object, ptr, length));
      } else if (operation.op === 'arrayAppend' || operation.op === 'arraySet') {
        const child = _rawNewObject(params.docHandle, operation.value, locals);
        try {
          const ok = operation.op === 'arrayAppend'
            ? w.FPDFRaw_ArrayAppend(target.object, child)
            : w.FPDFRaw_ArraySet(target.object, operation.index, child);
          if (!ok) throw new Error(`Could not apply raw PDF ${operation.op}`);
        } finally {
          w.FPDFRaw_CloseObject(child);
        }
      } else if (operation.op === 'arrayRemove') {
        if (!w.FPDFRaw_ArrayRemove(target.object, operation.index)) throw new Error('Could not remove raw PDF array item');
      } else if (operation.op === 'streamSetData') {
        const ok = _rawWithBytes(operation.data, (ptr, length) => w.FPDFRaw_StreamSetData(target.object, ptr, length));
        if (!ok) throw new Error('Could not replace raw PDF stream data');
      }
    } finally {
      target.close();
    }
  }
  return { created: locals };
}
// [pdfrx_web: raw PDF object support]

/**
 * Functions that can be called from the main thread
 */
const functions = {
  loadDocumentFromUrl,
  loadDocumentFromData,
  retryDocumentFromData,
  cancelDocumentFromData,
  createNewDocument,
  createPagesFromImages,
  createPagesFromContents,
  loadPagesProgressively,
  reloadPages,
  closeDocument,
  loadOutline,
  loadPage,
  closePage,
  renderPage,
  loadText,
  loadLinks,
  reloadFonts,
  addFontData,
  clearAllFontData,
  assemble,
  encodePdf,
  rawGetObject,
  rawApplyPatch,
  cloneDocument,
  // [pdfrx_web: form support]
  loadFormFields,
  loadFormCalculations,
  setFormFieldValue,
  formOpenPage,
  formClosePage,
  formPointerEvent,
  formKeyEvent,
  formKillFocus,
  registerFormNotify,
  // [pdfrx_web: annotation support]
  loadAnnotations,
  addAnnotation,
  updateAnnotation,
  removeAnnotation,
};

/**
 * Send a callback invocation message back to the client
 * @param {number} callbackId The callback ID to invoke
 * @param {*} args Arguments to pass to the callback
 */
function invokeCallback(callbackId, ...args) {
  if (callbackId) {
    postMessage({
      type: 'callback',
      callbackId: callbackId,
      args: args,
    });
  }
}

function handleRequest(data) {
  const { id, command, parameters = {} } = data;

  try {
    const result = functions[command](parameters);
    if (result instanceof Promise) {
      result
        .then((finalResult) => {
          if (finalResult.result != null && finalResult.transfer != null) {
            postMessage({ id, status: 'success', result: finalResult.result }, finalResult.transfer);
          } else {
            postMessage({ id, status: 'success', result: finalResult });
          }
        })
        .catch((err) => {
          postMessage({
            id,
            status: 'error',
            error: _error(err),
          });
        });
    } else {
      if (result.result != null && result.transfer != null) {
        postMessage({ id, status: 'success', result: result.result }, result.transfer);
      } else {
        postMessage({ id, status: 'success', result: result });
      }
    }
  } catch (err) {
    postMessage({
      id,
      status: 'error',
      error: _error(err),
    });
  }
}

let messagesBeforeInitialized = [];
let pdfiumInitialized = false;

console.log(`PDFium worker initialized: ${self.location.href}`);

/**
 * Initialize PDFium with optional authentication parameters
 * @param {Object} params - Initialization parameters
 * @param {boolean} params.withCredentials - Whether to include credentials in the fetch
 * @param {Object} params.headers - Additional headers for the fetch request
 */
async function initializePdfium(params = {}) {
  try {
    if (pdfiumInitialized) {
      // Hot-restart or such may call this multiple times, so we can skip re-initialization
      return;
    }

    console.log(`Loading PDFium WASM module from ${pdfiumWasmUrl}`);

    const fetchOptions = {
      credentials: params.withCredentials ? 'include' : 'same-origin',
    };

    if (params.headers) {
      fetchOptions.headers = params.headers;
    }

    let result;
    try {
      result = await WebAssembly.instantiateStreaming(fetch(pdfiumWasmUrl, fetchOptions), {
        env: emEnv,
        wasi_snapshot_preview1: wasi,
      });
    } catch (e) {
      // Fallback for browsers that do not support instantiateStreaming
      console.warn(
        '%cWebAssembly.instantiateStreaming failed, falling back to ArrayBuffer instantiation. Consider to configure your server to serve wasm files as application/wasm',
        'background: red; color: white',
        e
      );
      const response = await fetch(pdfiumWasmUrl, fetchOptions);
      const buffer = await response.arrayBuffer();
      result = await WebAssembly.instantiate(buffer, {
        env: emEnv,
        wasi_snapshot_preview1: wasi,
      });
    }

    Pdfium.initWith(result.instance.exports);
    Pdfium.wasmExports.FPDF_InitLibrary();
    await _installFontMapper();

    pdfiumInitialized = true;

    postMessage({ type: 'ready' });

    // Process queued messages
    messagesBeforeInitialized.forEach((event) => handleRequest(event.data));
    messagesBeforeInitialized = null;
  } catch (err) {
    console.error('Failed to load WASM module:', err);
    postMessage({ type: 'error', error: _error(err) });
    throw err;
  }
}

onmessage = function (e) {
  const data = e.data;

  // Handle init command
  if (data && data.command === 'init') {
    initializePdfium(data.parameters || {})
      .then(() => {
        postMessage({ id: data.id, status: 'success', result: {} });
      })
      .catch((err) => {
        postMessage({ id: data.id, status: 'error', error: _error(err) });
      });
    return;
  }

  if (data && data.id && data.command) {
    if (!pdfiumInitialized && messagesBeforeInitialized) {
      messagesBeforeInitialized.push(e);
      return;
    }
    handleRequest(data);
  } else {
    console.error('Received improperly formatted message:', data);
  }
};

const _errorMappings = {
  0: 'FPDF_ERR_SUCCESS',
  1: 'FPDF_ERR_UNKNOWN',
  2: 'FPDF_ERR_FILE',
  3: 'FPDF_ERR_FORMAT',
  4: 'FPDF_ERR_PASSWORD',
  5: 'FPDF_ERR_SECURITY',
  6: 'FPDF_ERR_PAGE',
  7: 'FPDF_ERR_XFALOAD',
  8: 'FPDF_ERR_XFALAYOUT',
};

function _getErrorMessage(errorCode) {
  const error = _errorMappings[errorCode];
  return error ? `${error} (${errorCode})` : `Unknown error (${errorCode})`;
}

/**
 * String utilities
 */
class StringUtils {
  /**
   * UTF-16 string to bytes
   * @param {number[]} buffer
   * @returns {string} Converted string
   */
  static utf16BytesToString(buffer) {
    let endPtr = 0;
    while (buffer[endPtr] || buffer[endPtr + 1]) endPtr += 2;
    const str = new TextDecoder('utf-16le').decode(new Uint8Array(buffer.buffer, buffer.byteOffset, endPtr));
    return str;
  }
  /**
   * UTF-8 bytes to string
   * @param {number[]} buffer
   * @returns {string} Converted string
   */
  static utf8BytesToString(buffer) {
    let endPtr = 0;
    while (buffer[endPtr] && !(endPtr >= buffer.length)) ++endPtr;

    let str = '';
    let idx = 0;
    while (idx < endPtr) {
      let u0 = buffer[idx++];
      if (!(u0 & 0x80)) {
        str += String.fromCharCode(u0);
        continue;
      }
      const u1 = buffer[idx++] & 63;
      if ((u0 & 0xe0) == 0xc0) {
        str += String.fromCharCode(((u0 & 31) << 6) | u1);
        continue;
      }
      const u2 = buffer[idx++] & 63;
      if ((u0 & 0xf0) == 0xe0) {
        u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
      } else {
        u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (buffer[idx++] & 63);
      }
      if (u0 < 0x10000) {
        str += String.fromCharCode(u0);
      } else {
        const ch = u0 - 0x10000;
        str += String.fromCharCode(0xd800 | (ch >> 10), 0xdc00 | (ch & 0x3ff));
      }
    }
    return str;
  }
  /**
   * String to UTF-8 bytes
   * @param {string} str
   * @param {number[]} buffer
   * @returns {number} Number of bytes written to the buffer
   */
  static stringToUtf8Bytes(str, buffer) {
    let idx = 0;
    for (let i = 0; i < str.length; ++i) {
      let u = str.charCodeAt(i);
      if (u >= 0xd800 && u <= 0xdfff) {
        const u1 = str.charCodeAt(++i);
        u = (0x10000 + ((u & 0x3ff) << 10)) | (u1 & 0x3ff);
      }
      if (u <= 0x7f) {
        buffer[idx++] = u;
      } else if (u <= 0x7ff) {
        buffer[idx++] = 0xc0 | (u >> 6);
        buffer[idx++] = 0x80 | (u & 63);
      } else if (u <= 0xffff) {
        buffer[idx++] = 0xe0 | (u >> 12);
        buffer[idx++] = 0x80 | ((u >> 6) & 63);
        buffer[idx++] = 0x80 | (u & 63);
      } else {
        buffer[idx++] = 0xf0 | (u >> 18);
        buffer[idx++] = 0x80 | ((u >> 12) & 63);
        buffer[idx++] = 0x80 | ((u >> 6) & 63);
        buffer[idx++] = 0x80 | (u & 63);
      }
    }
    buffer[idx++] = 0;
    return idx;
  }
  /**
   * Calculate length of UTF-8 string in bytes (it does not contain the terminating '\0' character)
   * @param {string} str String to calculate length
   * @returns {number} Number of bytes
   */
  static lengthBytesUTF8(str) {
    let len = 0;
    for (let i = 0; i < str.length; ++i) {
      let u = str.charCodeAt(i);
      if (u >= 0xd800 && u <= 0xdfff) {
        u = (0x10000 + ((u & 0x3ff) << 10)) | (str.charCodeAt(++i) & 0x3ff);
      }
      if (u <= 0x7f) len += 1;
      else if (u <= 0x7ff) len += 2;
      else if (u <= 0xffff) len += 3;
      else len += 4;
    }
    return len;
  }
  /**
   * Allocate memory for UTF-8 string
   * @param {string} str
   * @returns {number} Pointer to allocated buffer that contains UTF-8 string. The buffer should be released by calling [freeUTF8].
   */
  static allocateUTF8(str) {
    if (str == null) return 0;
    const size = this.lengthBytesUTF8(str) + 1;
    const ptr = Pdfium.wasmExports.malloc(size);
    this.stringToUtf8Bytes(str, new Uint8Array(Pdfium.memory.buffer, ptr, size));
    return ptr;
  }
  /**
   * Release memory allocated for UTF-8 string
   * @param {number} ptr Pointer to allocated buffer
   */
  static freeUTF8(ptr) {
    Pdfium.wasmExports.free(ptr);
  }
  /**
   * [pdfrx_web: form support] Allocate a null-terminated UTF-16LE string
   * (FPDF_WIDESTRING), as required by FORM_ReplaceSelection and friends.
   * @param {string} str
   * @returns {number} Pointer to a buffer holding UTF-16LE + a 16-bit NUL. Free with [freeUTF8].
   */
  static allocateUTF16(str) {
    const s = str ?? '';
    const size = (s.length + 1) * 2;
    const ptr = Pdfium.wasmExports.malloc(size);
    const view = new Uint16Array(Pdfium.memory.buffer, ptr, s.length + 1);
    for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
    view[s.length] = 0;
    return ptr;
  }
}
