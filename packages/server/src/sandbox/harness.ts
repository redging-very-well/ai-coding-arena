// The in-sandbox harness (plan §8), exported as a string so the build needs no
// stray .js asset. The same source runs in every sandbox mode (isolated-vm and
// node:vm) and in both the validation and the battle sandboxes.
//
// The source is ONE function expression `(function setup(seed) { … })`. The
// host evaluates it, calls it once with the PRNG seed, and only THEN evaluates
// kid code. Everything the harness relies on (JSON.parse/stringify, Map and its
// methods, Reflect.apply/construct, the real clock…) is captured in the
// closure before any kid code exists, so kid code that patches globals or
// prototypes cannot change how the harness works.
//
// `setup` RETURNS the harness API; nothing callable is published on
// globalThis, so kid code (including microtasks that run after a call) can
// never reach it. The host keeps the API (isolated-vm: References taken before
// kid code runs; node:vm: a lexical binding with a random name):
//   load(unitId, wrapperFn)    evaluate one design's CJS wrapper, keep its default export
//   seal()                     refuse every later load (the host calls it after loading)
//   spawn(instanceId, unitId)  construct one copy, keep it in a Map
//   stats(instanceId)          describe the copy's stat properties (validation step 5)
//   sprite(instanceId)         call the copy's sprite() and JSON-copy the result (step 8b)
//   tick(inputJson)            run update() for every self in the input, return output JSON
//   reset()                    clear the running state after the host timed a call out
// Every entry point refuses while another one is running (no re-entrancy). A
// timeout terminates the isolate's script without running any `finally`, so
// the host calls reset() (after reading the culprit) to clear that state.
//
// Globals defined (non-configurable):
//   __current   (getter) the instanceId whose code is running right now; after
//               the tick loop, the last instance that queued a microtask or
//               returned a Promise (so a microtask loop still has a culprit)
//   __in        a writable data slot the node:vm host uses to pass a value
//
// All results are JSON *strings* built by concatenation, so the only kid
// controlled parts are individual JSON values (an action, an error message);
// the host still parses everything defensively.
//
// Hardening notes:
//  - `Math.random` is a seeded mulberry32 PRNG; `Date.now()`, `new Date()` and
//    Intl.DateTimeFormat's default date are the sim time. The real clock is
//    kept only for per-unit timing and never exposed to kid code.
//  - Memory that bypasses the isolate's memory limit is removed:
//    WebAssembly, SharedArrayBuffer, Atomics, and resizable ArrayBuffers
//    (the ArrayBuffer constructor ignores its options argument).
//  - Array/object literals and JSON.parse create own data properties, which
//    are immune to setters planted on Object/Array prototypes. The harness
//    therefore never writes to arrays by index or calls prototype methods.
//  - The tick input carries enemies/world/allies as ready-made JSON strings, so
//    the harness never JSON.stringify()s an object outside a unit's try/catch
//    (a kid-planted Object.prototype.toJSON can only run inside update()).

/** Names of the harness globals (used by the hosts). */
export const HARNESS_GLOBALS = {
  current: '__current',
  input: '__in',
} as const;

/** The harness API returned by `setup` (method names). */
export type HarnessApiFn = 'load' | 'seal' | 'spawn' | 'stats' | 'sprite' | 'tick' | 'reset';

/** The stat fields `stats()` reports, in order (mirrors shared STAT_FIELDS). */
const STAT_FIELD_LIST = "['name', 'type', 'maxHealth', 'damage', 'range', 'speed', 'attackCooldown', 'color', 'size', 'shape']";

/** Max length of one serialized action before it is replaced (keeps output small). */
export const MAX_ACTION_JSON = 4096;

/**
 * Max length of sprite()'s JSON copy (§7 step 8b). Mirrors shared
 * SPRITE_MAX_JSON_BYTES (a test keeps them equal): this file must not import
 * the shared package at runtime, because the sandbox child process loads it.
 */
export const MAX_SPRITE_JSON = 200 * 1024;

/** Max length of an error message the harness (and every host) passes on. */
export const MAX_ERROR_MESSAGE = 300;

export const HARNESS_SOURCE = String.raw`(function setup(seed) {
  'use strict';
  // ---- Intrinsics captured before any kid code runs ----------------------
  var G = globalThis;
  var defineProperty = Object.defineProperty;
  var gopd = Object.getOwnPropertyDescriptor;
  var getProto = Object.getPrototypeOf;
  var hasOwn = Object.hasOwn;
  var apply = Reflect.apply;
  var construct = Reflect.construct;
  var parse = JSON.parse;
  var stringify = JSON.stringify;
  var StringCtor = String;
  var RealDate = Date;
  var realNow = Date.now;
  var dateToString = Date.prototype.toString;
  var arraySlice = Array.prototype.slice;
  var strSlice = String.prototype.slice;
  var MapCtor = Map;
  var mapGet = Map.prototype.get;
  var mapSet = Map.prototype.set;
  var imul = Math.imul;
  var FIELDS = ${STAT_FIELD_LIST};
  var MAX_ACTION_JSON = ${MAX_ACTION_JSON};
  var MAX_ERROR_MESSAGE = ${MAX_ERROR_MESSAGE};
  var MAX_SPRITE_JSON = ${MAX_SPRITE_JSON};

  function mget(m, k) { return apply(mapGet, m, [k]); }
  function mset(m, k, v) { apply(mapSet, m, [k, v]); }
  function clock() { return apply(realNow, RealDate, []); }
  function cut(s, n) { return s.length > n ? apply(strSlice, s, [0, n]) : s; }
  function hide(obj, name, value) {
    defineProperty(obj, name, { value: value, writable: true, enumerable: false, configurable: true });
  }

  // ---- Memory the isolate's memoryLimit does not count -------------------
  // WebAssembly.Memory, SharedArrayBuffer and resizable ArrayBuffers are
  // allocated outside isolated-vm's ArrayBuffer allocator, so a unit could
  // use gigabytes despite the 32 MB limit. Remove them before kid code runs.
  var gone = ['WebAssembly', 'SharedArrayBuffer', 'Atomics'];
  for (var gi = 0; gi < gone.length; gi++) {
    try { delete G[gone[gi]]; } catch (_) { /* not configurable: leave it */ }
  }
  var RealAB = ArrayBuffer;
  // new ArrayBuffer(len) only: the options argument ({ maxByteLength }) is dropped.
  function AB(len) {
    if (new.target === undefined) throw new TypeError('Constructor ArrayBuffer requires \'new\'');
    return construct(RealAB, [len], new.target);
  }
  AB.prototype = RealAB.prototype;
  AB.isView = RealAB.isView;
  hide(RealAB.prototype, 'constructor', AB);
  hide(G, 'ArrayBuffer', AB);

  // ---- Determinism: seeded Math.random, Date = sim time -----------------
  var rngState = seed >>> 0;
  function random() {
    rngState = (rngState + 0x6D2B79F5) | 0;
    var t = rngState;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  hide(Math, 'random', random);

  var simNow = 0;
  function simDate() { return construct(RealDate, [simNow]); }
  function SimDate() {
    if (new.target === undefined) return apply(dateToString, simDate(), []);
    var args = arguments.length === 0 ? [simNow] : apply(arraySlice, arguments, []);
    return construct(RealDate, args, new.target);
  }
  SimDate.prototype = RealDate.prototype;
  SimDate.now = function now() { return simNow; };
  SimDate.parse = RealDate.parse;
  SimDate.UTC = RealDate.UTC;
  hide(RealDate.prototype, 'constructor', SimDate);
  hide(G, 'Date', SimDate);

  // Intl.DateTimeFormat#format()/formatToParts() with no date read the real
  // clock; default them to the sim time too.
  if (typeof Intl === 'object' && Intl !== null && typeof Intl.DateTimeFormat === 'function') {
    var dtfProto = Intl.DateTimeFormat.prototype;
    var fmtDesc = gopd(dtfProto, 'format');
    var fmtGet = fmtDesc && fmtDesc.get;
    if (typeof fmtGet === 'function') {
      defineProperty(dtfProto, 'format', {
        get: function () {
          var bound = apply(fmtGet, this, []);
          return function (d) { return bound(d === undefined ? simDate() : d); };
        },
        enumerable: false,
        configurable: true,
      });
    }
    var realFormatToParts = dtfProto.formatToParts;
    if (typeof realFormatToParts === 'function') {
      hide(dtfProto, 'formatToParts', function formatToParts(d) {
        return apply(realFormatToParts, this, [d === undefined ? simDate() : d]);
      });
    }
    // Warm up ICU now: its first use takes several ms of uninterruptible time,
    // which must not land inside a unit's tick budget.
    try {
      (0).toLocaleString();
      new Intl.DateTimeFormat().format(0);
      new RealDate(0).toLocaleString();
    } catch (_) { /* no ICU: nothing to warm up */ }
  }

  // ---- State --------------------------------------------------------------
  var current = '';            // instance whose code is running (read via __current)
  var lastPromiseOwner = '';   // last instance that queued a microtask / returned a Promise
  var designs = new MapCtor(); // unitId -> class
  var instances = new MapCtor(); // instanceId -> { obj, update }
  var busy = false;            // an entry point is running (no re-entrancy)
  var sealed = false;          // no more load once sealed / the first copy is spawned

  // ---- Microtasks keep their owner ----------------------------------------
  // A callback queued by a unit runs after the tick loop, when "current" is
  // empty. Wrap it so it runs as the instance that queued it; a microtask
  // loop then times out with the right culprit.
  function owned(cb) {
    if (typeof cb !== 'function' || current === '') return cb;
    var owner = current;
    lastPromiseOwner = owner;
    return function () {
      var prev = current;
      current = owner;
      try { return apply(cb, this, arguments); } finally { current = prev; }
    };
  }
  var realThen = Promise.prototype.then;
  hide(Promise.prototype, 'then', function then(onFulfilled, onRejected) {
    return apply(realThen, this, [owned(onFulfilled), owned(onRejected)]);
  });
  if (typeof G.queueMicrotask === 'function') {
    var realQueueMicrotask = G.queueMicrotask;
    hide(G, 'queueMicrotask', function queueMicrotask(cb) {
      return apply(realQueueMicrotask, G, [owned(cb)]);
    });
  }

  // A thrown value -> '{"message":…,"stack":…}' (never throws itself).
  function describe(e) {
    var message = 'unknown error';
    var stack = '';
    try {
      if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
        var m = e.message;
        var n = e.name;
        if (typeof m === 'string') message = (typeof n === 'string' && n ? cut(n, 100) + ': ' : '') + cut(m, MAX_ERROR_MESSAGE);
        else message = 'threw ' + cut(StringCtor(e), MAX_ERROR_MESSAGE);
        var s = e.stack;
        if (typeof s === 'string') stack = s;
      } else {
        message = 'threw ' + (typeof e === 'string' ? stringify(cut(e, MAX_ERROR_MESSAGE)) : StringCtor(e));
      }
    } catch (_) { /* keep defaults */ }
    return '{"message":' + stringify(cut(StringCtor(message), MAX_ERROR_MESSAGE)) + ',"stack":' + stringify(cut(stack, 2000)) + '}';
  }

  // Encode one stat value without losing its type (JSON would turn NaN into null).
  function encode(v) {
    var t = typeof v;
    if (t === 'number') {
      if (v !== v) return '{"num":"NaN"}';
      if (v === 1 / 0) return '{"num":"Infinity"}';
      if (v === -1 / 0) return '{"num":"-Infinity"}';
      return '{"num":' + stringify(v) + '}';
    }
    if (t === 'string') return '{"str":' + stringify(cut(v, 200)) + '}';
    if (t === 'boolean') return '{"bool":' + (v ? 'true' : 'false') + '}';
    if (v === null) return '{"null":true}';
    if (t === 'undefined') return '{"undef":true}';
    return '{"other":' + stringify(t) + '}';
  }

  // ---- load: evaluate one design -----------------------------------------
  function load(unitId, wrapper) {
    // A design id is registered once; a second load of the same id is refused.
    if (sealed || typeof unitId !== 'string' || typeof wrapper !== 'function' || mget(designs, unitId) !== undefined) {
      return '{"ok":false,"kind":"refused"}';
    }
    var mod = { exports: {} };
    try {
      apply(wrapper, undefined, [mod, mod.exports]);
    } catch (e) {
      return '{"ok":false,"kind":"threw","error":' + describe(e) + '}';
    }
    var def;
    try {
      var exp = mod.exports;
      def = exp !== null && (typeof exp === 'object' || typeof exp === 'function') ? exp['default'] : undefined;
    } catch (e) {
      return '{"ok":false,"kind":"threw","error":' + describe(e) + '}';
    }
    if (def === undefined || def === null) return '{"ok":false,"kind":"no-default"}';
    if (typeof def !== 'function') return '{"ok":false,"kind":"not-a-class","type":' + stringify(typeof def) + '}';
    try {
      // Throws if def is not a constructor (arrow function, method…) without calling it.
      construct(function () {}, [], def);
    } catch (_) {
      return '{"ok":false,"kind":"not-a-class","type":"function"}';
    }
    mset(designs, unitId, def);
    return '{"ok":true}';
  }

  function seal() {
    sealed = true;
    return '{"ok":true}';
  }

  // ---- spawn: construct one copy -----------------------------------------
  function spawn(instanceId, unitId) {
    sealed = true;
    if (typeof instanceId !== 'string' || typeof unitId !== 'string') return '{"ok":false,"kind":"bad-args"}';
    var Ctor = mget(designs, unitId);
    if (Ctor === undefined) return '{"ok":false,"kind":"unknown-design"}';
    var obj;
    var upd;
    current = instanceId;
    try {
      obj = construct(Ctor, []);
      upd = obj.update;
    } catch (e) {
      current = '';
      return '{"ok":false,"kind":"threw","error":' + describe(e) + '}';
    }
    current = '';
    var hasUpdate = typeof upd === 'function';
    // update() is captured now; reassigning this.update later changes nothing.
    mset(instances, instanceId, { obj: obj, update: hasUpdate ? upd : undefined });
    return '{"ok":true,"hasUpdate":' + (hasUpdate ? 'true' : 'false') + '}';
  }

  // ---- stats: own data properties only (validation step 5) ---------------
  function stats(instanceId) {
    var inst = mget(instances, instanceId);
    if (inst === undefined) return '{"ok":false,"kind":"unknown-instance"}';
    var obj = inst.obj;
    var out = '';
    current = instanceId;
    try {
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i];
        var entry;
        var d = gopd(obj, f);
        if (d === undefined) {
          var kind = 'missing';
          var p = getProto(obj);
          while (p !== null) {
            var pd = gopd(p, f);
            if (pd !== undefined) { kind = hasOwn(pd, 'value') ? 'inherited' : 'getter'; break; }
            p = getProto(p);
          }
          entry = '{"kind":"' + kind + '"}';
        } else if (hasOwn(d, 'get') || hasOwn(d, 'set')) {
          entry = '{"kind":"getter"}';
        } else {
          entry = '{"kind":"data","v":' + encode(d.value) + '}';
        }
        out += (i ? ',' : '') + stringify(f) + ':' + entry;
      }
    } catch (e) {
      current = '';
      return '{"ok":false,"kind":"threw","error":' + describe(e) + '}';
    }
    current = '';
    return '{"ok":true,"fields":{' + out + '}}';
  }

  // ---- sprite: call sprite() once and JSON-copy the result (step 8b) ------
  // Replies {"ok":true,"none":true} when there is no sprite() method,
  // {"ok":true,"json":"<the JSON copy>"} (null when it returned undefined),
  // {"ok":false,"kind":"too-big","length":n} over MAX_SPRITE_JSON characters,
  // or {"ok":false,"kind":"threw","error":…}.
  function sprite(instanceId) {
    var inst = mget(instances, instanceId);
    if (inst === undefined) return '{"ok":false,"kind":"unknown-instance"}';
    var json;
    current = instanceId;
    try {
      var fn = inst.obj.sprite;
      if (typeof fn !== 'function') { current = ''; return '{"ok":true,"none":true}'; }
      json = stringify(apply(fn, inst.obj, []));
    } catch (e) {
      current = '';
      return '{"ok":false,"kind":"threw","error":' + describe(e) + '}';
    }
    current = '';
    if (json === undefined) return '{"ok":true,"json":null}';
    if (json.length > MAX_SPRITE_JSON) return '{"ok":false,"kind":"too-big","length":' + json.length + '}';
    return '{"ok":true,"json":' + stringify(json) + '}';
  }

  // ---- tick: one update() per self ---------------------------------------
  // Input (built by the host, see encodeTickInput):
  //   { nowMs, selves: [SelfView], enemiesJson, worldJson, allyIds: [id], alliesJson: [json] }
  function str(v, fallback) { return typeof v === 'string' ? v : fallback; }
  function tick(json) {
    var input = parse(json);
    simNow = input.nowMs;
    lastPromiseOwner = '';
    var selves = input.selves;
    var enemiesJson = str(input.enemiesJson, '[]');
    var worldJson = str(input.worldJson, '{}');
    var allyIds = input.allyIds;
    var alliesJson = input.alliesJson;
    var nA = allyIds.length;
    var out = '';
    for (var k = 0; k < selves.length; k++) {
      var self = selves[k];
      var id = self.id;
      // Allies minus self, as a fresh copy for this call.
      var aj = '[';
      var first = true;
      for (var a = 0; a < nA; a++) {
        if (allyIds[a] !== id) { aj += (first ? '' : ',') + str(alliesJson[a], 'null'); first = false; }
      }
      aj += ']';
      var head = (k ? ',' : '') + '{"instanceId":' + stringify(id);
      var inst = mget(instances, id);
      if (inst === undefined) { out += head + ',"error":{"message":"this copy was never spawned"},"ms":0}'; continue; }
      if (inst.update === undefined) { out += head + ',"error":{"message":"TypeError: update is not a function"},"ms":0}'; continue; }
      current = id;
      var t0 = clock();
      var body;
      try {
        var act = apply(inst.update, inst.obj, [self, parse(enemiesJson), parse(aj), parse(worldJson)]);
        if (act !== null && typeof act === 'object' && typeof act.then === 'function') {
          lastPromiseOwner = id;
          body = ',"promise":true';
        } else {
          var actJson = stringify(act);
          if (actJson === undefined) body = '';
          else if (actJson.length > MAX_ACTION_JSON) body = ',"action":"too-big"';
          else body = ',"action":' + actJson;
        }
      } catch (e) {
        body = ',"error":' + describe(e);
      }
      current = '';
      out += head + body + ',"ms":' + (clock() - t0) + '}';
    }
    return '[' + out + ']';
  }

  // ---- The API (returned, never published) --------------------------------
  function guarded(fn) {
    return function () {
      if (busy) return '{"ok":false,"kind":"busy"}';
      busy = true;
      try {
        return apply(fn, undefined, arguments);
      } catch (e) {
        // A harness bug or bad host input; never let a raw error escape.
        return '{"ok":false,"kind":"harness-error","error":' + describe(e) + '}';
      } finally {
        busy = false;
      }
    };
  }
  defineProperty(G, '__current', {
    get: function () { return current !== '' ? current : lastPromiseOwner; },
    enumerable: false,
    configurable: false,
  });
  defineProperty(G, '__in', { value: '', writable: true, enumerable: false, configurable: false });
  // After a terminated (timed-out) call: nothing is running any more.
  function reset() {
    busy = false;
    current = '';
    lastPromiseOwner = '';
    return '{"ok":true}';
  }
  return {
    reset: reset,
    load: guarded(load),
    seal: guarded(seal),
    spawn: guarded(spawn),
    stats: guarded(stats),
    sprite: guarded(sprite),
    tick: guarded(tick),
  };
})`;

/**
 * Wrap a design's compiled CJS so evaluating the script only CREATES the
 * function; kid code runs when the harness calls it from `__load`. The
 * wrapper adds one line before the code (see WRAPPER_LINE_OFFSET).
 */
export function wrapUnit(compiledJs: string): string {
  return `(function (module, exports) {\n${compiledJs}\n})`;
}

/** Lines added before the compiled code by `wrapUnit`. */
export const WRAPPER_LINE_OFFSET = 1;

/** Script filename for design #i (appears in stack traces). */
export function unitFilename(index: number): string {
  return `unit-${index}.js`;
}
