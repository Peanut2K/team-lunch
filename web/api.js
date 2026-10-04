/* ข้าวเที่ยงทีม — ชั้นเรียก API ตัวเดียวของหน้าเว็บ (Decision log D5)
 *
 * ทุกหน้าเรียก API ผ่าน TL.api เท่านั้น — สลับได้ระหว่าง
 *   'real' : fetch ไปที่ /api/... (เมื่อเสิร์ฟผ่าน backend)
 *   'mock' : TL.mockServer ในหน้าเว็บ (เมื่อเปิด web/index.html ตรงๆ)
 *
 * เลือกโหมด: ?api=mock | ?api=real  ถ้าไม่ระบุ → เปิดจากไฟล์ (file:) ใช้ mock, เสิร์ฟผ่าน http ใช้ real
 *
 * ผลลัพธ์: resolve เป็น body ที่ API ตอบ (204 → null)
 * ผิดพลาด: reject เป็น TL.ApiError { status, code, message } — message มาจาก API ตรงๆ ให้แสดงผู้ใช้ได้เลย
 */
(function () {
  'use strict';

  var TL = (window.TL = window.TL || {});

  function ApiError(status, code, message) {
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.message = message;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function pickMode() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('api'); } catch (e) { /* ignore */ }
    if (q === 'mock' || q === 'real') return q;
    return location.protocol === 'file:' ? 'mock' : 'real';
  }
  var mode = pickMode();
  if (mode === 'mock' && !TL.mockServer) mode = 'real';

  var NETWORK_MESSAGE = 'ติดต่อ server ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง';

  function toResult(status, body) {
    if (status >= 200 && status < 300) return status === 204 ? null : body;
    var err = body && body.error;
    if (err && typeof err.message === 'string') {
      throw new ApiError(status, err.code || 'UNKNOWN', err.message);
    }
    throw new ApiError(status, 'HTTP_' + status, 'เกิดข้อผิดพลาดจาก server (' + status + ') ลองใหม่อีกครั้ง');
  }

  function viaMock(method, path, bodyText) {
    return TL.mockServer.handle(method, path, bodyText).then(function (res) {
      return toResult(res.status, res.body);
    });
  }

  function viaFetch(method, path, bodyText) {
    var init = { method: method, headers: { Accept: 'application/json' } };
    if (bodyText !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = bodyText;
    }
    return fetch(path, init).then(
      function (res) {
        if (res.status === 204) return toResult(204, null);
        return res.text().then(function (text) {
          var body = null;
          if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }
          return toResult(res.status, body);
        });
      },
      function () { throw new ApiError(0, 'NETWORK', NETWORK_MESSAGE); }
    );
  }

  function request(method, path, body) {
    var bodyText = body === undefined ? undefined : JSON.stringify(body);
    return mode === 'mock' ? viaMock(method, path, bodyText) : viaFetch(method, path, bodyText);
  }

  var enc = encodeURIComponent;

  TL.ApiError = ApiError;
  TL.api = {
    mode: mode,
    /** POST /api/rounds — body: { restaurant, cutoffAt, items: [{ name, price }] } → Round */
    createRound: function (body) { return request('POST', '/api/rounds', body); },
    /** GET /api/rounds/today → Round (404 NO_ROUND) */
    getToday: function () { return request('GET', '/api/rounds/today'); },
    /** PUT /api/rounds/:id/orders — body: { name, lines: [{ itemId, qty }], note? } → Order */
    putOrder: function (roundId, body) { return request('PUT', '/api/rounds/' + enc(roundId) + '/orders', body); },
    /** DELETE /api/rounds/:id/orders/:name → null */
    deleteOrder: function (roundId, name) {
      return request('DELETE', '/api/rounds/' + enc(roundId) + '/orders/' + enc(name));
    },
    /** GET /api/rounds/:id/summary → Summary */
    getSummary: function (roundId) { return request('GET', '/api/rounds/' + enc(roundId) + '/summary'); }
  };
})();
