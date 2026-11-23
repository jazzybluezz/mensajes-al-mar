/* Mensajes al Mar — app de botellas con pistas para Navidad */
(function(){
'use strict';

/* ====== configuración ====== */
var CFG = window.MM_CONFIG || {};
var ENV = CFG.env === 'real' ? 'real' : 'prueba';
var IS_TEST = ENV === 'prueba';
var NAMES = {jean:'Jean', paty:'Paty'};
var LAUNCH = '2026-12-01', LAST_DAY = '2026-12-24', REVEAL = '2026-12-25', MAX = 4;
function other(r){ return r === 'jean' ? 'paty' : 'jean'; }

/* ====== utilidades ====== */
var mem = {};
function lsGet(k){ try{ var v = localStorage.getItem(k); return v === null ? (mem[k] || null) : v; }catch(e){ return mem[k] || null; } }
function lsSet(k, v){ try{ if(v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); }catch(e){} if(v === null || v === undefined) delete mem[k]; else mem[k] = v; }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function $(s, el){ return (el || document).querySelector(s); }
function validPhoto(p){ return typeof p === 'string' && p.indexOf('data:image/') === 0; }
function addDays(d, n){ var x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

/* ====== reloj (hora de Lima) ====== */
var OFF = -5 * 3600e3, serverOffset = 0, bootReal = Date.now();
var FAKE_KEY = 'mm_fake_' + ENV, VIEWAS_KEY = 'mm_viewas_' + ENV;
function fakeBase(){ if(!IS_TEST) return null; var f = lsGet(FAKE_KEY); return f ? Date.parse(f + 'T12:00:00-05:00') : null; }
function nowMs(){ var b = fakeBase(); return b ? b + (Date.now() - bootReal) : Date.now() + serverOffset; }
function todayStr(){ return new Date(nowMs() + OFF).toISOString().slice(0, 10); }
function endOfDayMs(){ return Date.parse(todayStr() + 'T00:00:00-05:00') + 86400000; }
function fmtDate(d){ return new Date(d + 'T12:00:00Z').toLocaleDateString('es-PE', {timeZone:'UTC', weekday:'long', day:'numeric', month:'long'}); }
function fmtShort(d){ return new Date(d + 'T12:00:00Z').toLocaleDateString('es-PE', {timeZone:'UTC', day:'numeric', month:'short'}); }
function hms(ms){ if(ms < 0) ms = 0; var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return [h, m, x].map(function(n){ return String(n).padStart(2, '0'); }).join(':'); }

/* ====== Supabase ====== */
var sb = null;
try{
  sb = window.supabase.createClient(CFG.url, CFG.key, {
    auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:false, storageKey:'mm-auth' }
  });
}catch(e){ console.error(e); }

/* ====== estado ====== */
var S = {
  session:null, serverRole:null, role:null, authChecked:false,
  bottles:[], schedule:[], guesses:[], guessStatus:[], notes:[],
  tab:'orilla', ready:false, loadErr:false, dirty:false, signup:false
};
function resolveRole(){
  if(IS_TEST){ var v = lsGet(VIEWAS_KEY); if(v === 'jean' || v === 'paty') return v; }
  return S.serverRole;
}

var refreshing = false, refreshAgain = false;
async function refresh(){
  if(!sb || !S.session) return;
  if(refreshing){ refreshAgain = true; return; }
  refreshing = true;
  try{
    var w = await sb.rpc('whoami');
    if(w.error) throw w.error;
    S.serverRole = w.data && w.data.role || null;
    if(w.data && w.data.now){ serverOffset = Date.parse(w.data.now) - Date.now(); }
    S.role = resolveRole();
    var res = await Promise.all([
      sb.from('bottles').select('id,author,slot,arrive_on,body,has_photo,updated_at').eq('env', ENV),
      sb.from('guesses').select('author,body,updated_at').eq('env', ENV),
      sb.from('notes').select('id,body,created_at').eq('env', ENV).order('created_at', {ascending:false})
    ]);
    for(var i = 0; i < res.length; i++){ if(res[i].error) throw res[i].error; }
    S.bottles = res[0].data || []; S.guesses = res[1].data || []; S.notes = res[2].data || [];
    if(!IS_TEST){
      var r2 = await Promise.all([ sb.rpc('incoming_schedule', {p_env:ENV}), sb.rpc('guess_status', {p_env:ENV}) ]);
      if(r2[0].error) throw r2[0].error; if(r2[1].error) throw r2[1].error;
      S.schedule = (r2[0].data || []).map(function(x){ return x.arrive_on; });
      S.guessStatus = (r2[1].data || []).map(function(x){ return x.author; });
    }
    S.loadErr = false;
  }catch(e){
    console.warn('refresh', e);
    S.loadErr = true;
  }finally{
    refreshing = false; S.ready = true; safeRender();
    if(refreshAgain){ refreshAgain = false; setTimeout(refresh, 50); }
  }
}

/* ====== escrituras ====== */
function chk(r){ if(r && r.error) throw r.error; return r; }
function errMsg(e){
  var c = e && e.code, m = (e && e.message) || '';
  if(c === '23505') return 'Ya tienes otra botella ese día. Elige uno distinto.';
  if(c === '42501') return 'Eso ya no se puede cambiar: la fecha ya llegó o ya pasó.';
  if(c === '23514') return 'Revisa la fecha (del 1 al 24 de diciembre), que el texto no esté vacío y que la foto no sea muy pesada.';
  if(/fetch|network|Failed/i.test(m)) return 'Sin conexión con el mar. Revisa tu internet e inténtalo de nuevo.';
  return 'No se pudo guardar. Inténtalo de nuevo.';
}
function fail(e){ console.warn(e); toast(errMsg(e)); }
var DB = {
  saveBottle: function(slot, d, text, photo){
    var row = {env:ENV, author:S.role, slot:slot, arrive_on:d, body:text};
    if(photo !== 'keep') row.photo = photo;
    return sb.from('bottles').upsert(row, {onConflict:'env,author,slot'}).then(chk);
  },
  delBottle: function(slot){ return sb.from('bottles').delete().eq('env', ENV).eq('author', S.role).eq('slot', slot).then(chk); },
  saveGuess: function(text){ return sb.from('guesses').upsert({env:ENV, author:S.role, body:text}, {onConflict:'env,author'}).then(chk); },
  addNote: function(text){ return sb.from('notes').insert({env:ENV, body:text}).then(chk); },
  delNote: function(id){ return sb.from('notes').delete().eq('id', id).then(chk); },
  resetTest: function(){
    return Promise.all([
      sb.from('bottles').delete().eq('env', 'prueba').then(chk),
      sb.from('guesses').delete().eq('env', 'prueba').then(chk),
      sb.from('notes').delete().eq('env', 'prueba').then(chk)
    ]);
  }
};
var photoCache = {};
function getPhoto(b){
  var k = b.id + '|' + b.updated_at;
  if(photoCache[k] !== undefined) return Promise.resolve(photoCache[k]);
  return sb.from('bottles').select('photo').eq('id', b.id).maybeSingle().then(function(r){
    var p = r.data && r.data.photo; photoCache[k] = validPhoto(p) ? p : null; return photoCache[k];
  });
}

/* ====== SVG ====== */
function bottleSVG(cls, withScroll){
  return '<svg class="bottle ' + (cls || '') + '" viewBox="0 0 120 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<rect x="47" y="4" width="26" height="28" rx="6" fill="#b07a3e" stroke="#7b4f1f" stroke-width="2"/>' +
  '<path d="M48 32H72V62C72 82 108 92 108 130V190C108 206 98 214 84 214H36C22 214 12 206 12 190V130C12 92 48 82 48 62Z" fill="rgba(170,230,228,.38)" stroke="rgba(230,255,255,.85)" stroke-width="3"/>' +
  (withScroll === false ? '' : '<g transform="rotate(-12 60 150)"><rect x="40" y="108" width="40" height="84" rx="8" fill="#f1e0b3" stroke="#a9843f" stroke-width="2"/><path d="M48 126H72M48 138H72M48 150H66M48 162H72" stroke="#8a6a30" stroke-width="2.4" stroke-linecap="round"/><rect x="40" y="141" width="40" height="7" fill="#a3281f" opacity=".9"/></g>') +
  '<path d="M24 122C22 150 24 178 30 196" stroke="rgba(255,255,255,.7)" stroke-width="5" stroke-linecap="round" fill="none"/></svg>';
}
function waves(){
  var p = 'M0 30 Q 25 8 50 30 T 100 30 T 150 30 T 200 30 T 250 30 T 300 30 T 350 30 T 400 30 V60 H0Z';
  return '<svg class="wave" style="bottom:22px" viewBox="0 0 400 60" preserveAspectRatio="none"><path d="' + p + '" fill="#7fd0d8"/></svg>' +
         '<svg class="wave w2" style="bottom:0" viewBox="0 0 400 60" preserveAspectRatio="none"><path d="' + p + '" fill="#0d3f5a"/></svg>';
}

/* ====== lógica del juego ====== */
function byDate(a, b){ return a.arrive_on < b.arrive_on ? -1 : 1; }
function myBottles(){ return S.bottles.filter(function(b){ return b.author === S.role; }).sort(byDate); }
function incoming(){ return S.bottles.filter(function(b){ return b.author === other(S.role); }).sort(byDate); }
function todaysBottle(){ var t = todayStr(); return incoming().filter(function(b){ return b.arrive_on === t; })[0] || null; }
function shelfBottles(){ var t = todayStr(); return incoming().filter(function(b){ return b.arrive_on < t; }); }
function scheduleDates(){ return IS_TEST ? incoming().map(function(b){ return b.arrive_on; }) : S.schedule.slice().sort(); }
function upcoming(){ var t = todayStr(); return scheduleDates().filter(function(d){ return d > t; }); }
function guessOf(r){ return S.guesses.filter(function(g){ return g.author === r; })[0] || null; }
function hasGuessed(r){ return IS_TEST ? !!guessOf(r) : S.guessStatus.indexOf(r) >= 0; }
function revealed(){ return todayStr() >= REVEAL; }
function minArrive(){ if(IS_TEST) return LAUNCH; var tm = addDays(todayStr(), 1); return tm > LAUNCH ? tm : LAUNCH; }
function canEdit(b){ return IS_TEST ? todayStr() < b.arrive_on : todayStr() < b.arrive_on; }

/* ====== render ====== */
var modalOpen = false;
function safeRender(){
  var a = document.activeElement;
  if(modalOpen || (a && /^(TEXTAREA|INPUT)$/.test(a.tagName))){ S.dirty = true; return; }
  S.dirty = false; render();
}
document.addEventListener('focusout', function(){ setTimeout(function(){ if(S.dirty) safeRender(); }, 250); });

function header(){
  var who = S.role ? '<button class="pill" id="acct">' + esc(NAMES[S.role]) + ' ▾</button>' : '';
  return '<header class="top"><div class="logo" id="logo">🧭</div><div><h1>Mensajes al Mar</h1><small>Pistas en botellas, rumbo a Navidad</small></div>' + who + '</header>';
}
function render(){
  var root = $('#root');
  if(!sb){ root.innerHTML = '<div class="app">' + header() + '<div class="banner err">No se pudo cargar la app. Recarga la página.</div></div>'; return; }
  if(!S.authChecked){ root.innerHTML = '<div class="app"><p class="muted" style="text-align:center;margin-top:40vh">Izando velas…</p></div>'; return; }
  if(!S.session){ root.innerHTML = vLogin(); bindLogin(); return; }
  if(!S.ready){ root.innerHTML = '<div class="app">' + header() + '<p class="muted" style="text-align:center;margin-top:30vh">Buscando botellas en el mar…</p></div>'; bindHeader(); return; }
  if(!S.serverRole){
    root.innerHTML = '<div class="app">' + header() + (S.loadErr ? '<div class="banner err">No puedo alcanzar el mar todavía. Revisa tu conexión.</div>' : '<div class="banner err">Esta cuenta no está invitada al juego.</div>') + '<div class="row" style="justify-content:center"><button class="btn ghost" id="logout2">Cerrar sesión</button></div></div>';
    bindHeader(); var lo = $('#logout2'); if(lo) lo.onclick = logout; return;
  }
  var t = todayStr();
  var h = '<div class="app">' + header();
  if(IS_TEST) h += '<div class="banner test">Versión de prueba: aquí todo se puede borrar. Toca 5 veces la brújula para viajar en el tiempo.</div>';
  if(S.loadErr) h += '<div class="banner err">No puedo alcanzar el mar ahora mismo. Lo que ves puede estar desactualizado.</div>';
  if(!IS_TEST && t < LAUNCH) h += '<div class="banner">El mar abre el ' + esc(fmtDate(LAUNCH)) + '. Mientras tanto, prepara tus botellas en el Taller.</div>';
  if(fakeBase()) h += '<div class="banner">Reloj de prueba: hoy es ' + esc(fmtDate(t)) + '.' + (S.role !== S.serverRole ? ' Estás viendo la app como ' + esc(NAMES[S.role]) + '.' : '') + '</div>';
  else if(IS_TEST && S.role !== S.serverRole) h += '<div class="banner">Estás viendo la app como ' + esc(NAMES[S.role]) + '.</div>';
  h += '<main>' + ({orilla:vOrilla, taller:vTaller, repisa:vRepisa, cofre:vCofre})[S.tab]() + '</main></div>';
  h += '<nav class="tabs"><div class="in">' + [['orilla','🌊','Orilla'],['taller','✒️','Taller'],['repisa','🗄️','Repisa'],['cofre','🏴‍☠️','Cofre']].map(function(x){ return '<button data-tab="' + x[0] + '" class="' + (S.tab === x[0] ? 'on' : '') + '"><span>' + x[1] + '</span>' + x[2] + '</button>'; }).join('') + '</div></nav>';
  root.innerHTML = h;
  bind(); tick();
}

function vLogin(){
  var su = S.signup;
  return '<div class="app login"><header class="top"><div class="logo">🧭</div><div><h1>Mensajes al Mar</h1><small>Pistas en botellas, rumbo a Navidad</small></div></header>' +
  '<div class="paper" style="margin-top:22px"><div class="seal">⚓</div><h3>' + (su ? 'Primera vez a bordo' : 'Subir a bordo') + '</h3>' +
  '<p class="muted" style="margin:4px 0 6px">' + (su ? 'Escribe tu correo y crea tu contraseña. Solo tú la vas a saber.' : 'Entra con tu correo y tu contraseña.') + '</p>' +
  '<form id="lf" autocomplete="on">' +
  '<label for="l-email">Correo</label><input type="email" id="l-email" autocomplete="email" required inputmode="email">' +
  '<label for="l-pass">' + (su ? 'Crea tu contraseña (mínimo 6 caracteres)' : 'Contraseña') + '</label><input type="password" id="l-pass" autocomplete="' + (su ? 'new-password' : 'current-password') + '" required minlength="6">' +
  (su ? '<label for="l-pass2">Repite la contraseña</label><input type="password" id="l-pass2" autocomplete="new-password" required minlength="6">' : '') +
  '<p id="l-msg" class="lmsg" role="alert"></p>' +
  '<div class="row" style="margin-top:6px"><button class="btn" type="submit" id="l-go">' + (su ? 'Crear y entrar' : 'Entrar') + '</button></div></form>' +
  '<p style="margin:16px 0 0"><a href="#" id="l-toggle" class="plink">' + (su ? 'Ya tengo contraseña' : 'Es mi primera vez') + '</a></p>' +
  '<p class="muted" style="margin:10px 0 0;font-size:14px">¿Olvidaste tu contraseña? Avísale a Jean.</p></div></div>';
}
function authErr(e){
  var m = (e && e.message) || '';
  if(/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if(/Database error saving new user|not_invited/i.test(m)) return 'Ese correo no está invitado a este mar.';
  if(/already registered|already been registered/i.test(m)) return 'Ese correo ya tiene contraseña. Toca «Ya tengo contraseña».';
  if(/at least|weak/i.test(m)) return 'La contraseña debe tener al menos 6 caracteres.';
  if(/not confirmed/i.test(m)) return 'Ese correo todavía no está confirmado. Avísale a Jean.';
  if(/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos.';
  if(/fetch|network/i.test(m)) return 'Sin conexión. Revisa tu internet.';
  return 'No se pudo entrar. ' + m;
}
function bindLogin(){
  var msg = $('#l-msg');
  $('#l-toggle').onclick = function(e){ e.preventDefault(); S.signup = !S.signup; render(); };
  $('#lf').onsubmit = async function(e){
    e.preventDefault();
    var email = $('#l-email').value.trim().toLowerCase(), pass = $('#l-pass').value, btn = $('#l-go');
    msg.textContent = '';
    if(S.signup){
      if(pass.length < 6){ msg.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
      if(pass !== $('#l-pass2').value){ msg.textContent = 'Las contraseñas no coinciden.'; return; }
    }
    btn.disabled = true;
    try{
      var r = S.signup ? await sb.auth.signUp({email:email, password:pass}) : await sb.auth.signInWithPassword({email:email, password:pass});
      if(r.error){ msg.textContent = authErr(r.error); btn.disabled = false; return; }
      if(S.signup && !r.data.session){
        msg.textContent = 'Cuenta creada, pero falta confirmarla. Avísale a Jean.'; btn.disabled = false; return;
      }
    }catch(err){ msg.textContent = authErr(err); btn.disabled = false; }
  };
}
async function logout(){ closeModal(); try{ await sb.auth.signOut(); }catch(e){} lsSet(VIEWAS_KEY, null); S.signup = false; S.ready = false; S.serverRole = null; S.role = null; S.bottles = []; S.notes = []; S.guesses = []; render(); }

function vOrilla(){
  var me = S.role, o = other(me), b = todaysBottle(), up = upcoming(), h = '';
  if(b){
    h += '<div class="sea"><div class="sun"></div>' + waves() + '<div class="bottle-wrap" id="today-btl">' + bottleSVG('glow') + '</div><div class="cap">Una botella de ' + esc(NAMES[o]) + ' llegó a la orilla</div></div>';
    h += '<div class="card" style="text-align:center"><div class="muted">El mar se la llevará en</div><div class="count" id="cd">--:--:--</div><p class="muted" style="margin:6px 0 14px">Después quedará guardada en tu repisa.</p><button class="btn" id="open-today">Abrir botella</button></div>';
  }else{
    h += '<div class="sea night"><div class="sun" style="background:#e9eefb;opacity:.7;width:60px;height:60px"></div>' + waves() + '<div class="cap" style="bottom:70px;font-size:19px">Hoy el mar está en calma.<br>No hay botellas nuevas.</div></div>';
  }
  var total = scheduleDates().length, done = shelfBottles().length + (b ? 1 : 0);
  h += '<div class="card"><h2>Rumbo al tesoro</h2><p class="muted">Botellas de ' + esc(NAMES[o]) + ' en camino: <b style="color:#fff">' + total + '</b> de ' + MAX + '. Ya llegaron: <b style="color:#fff">' + done + '</b>.</p>';
  if(up.length) h += '<div>' + up.map(function(d){ return '<span class="chip">🍾 ' + esc(fmtShort(d)) + '</span>'; }).join('') + '</div><p class="muted">Cada una se abre solo el día que le toca.</p>';
  else if(!total) h += '<p class="muted">' + esc(NAMES[o]) + ' todavía no ha sellado ninguna botella.</p>';
  h += '</div>';
  var mine = myBottles();
  h += '<div class="card"><p class="muted" style="margin:0">Tus botellas selladas: <b style="color:#fff">' + mine.length + '</b> de ' + MAX + '. ' + (mine.length < MAX ? 'Aún puedes escribir más en el Taller.' : '¡Listas para navegar!') + '</p></div>';
  return h;
}

function vTaller(){
  var me = S.role, h = '<div class="card"><h2>Taller de botellas</h2><p class="muted">Escribe hasta ' + MAX + ' pistas para ' + esc(NAMES[other(me)]) + '. Cada botella llega un día distinto, entre el ' + esc(fmtShort(LAUNCH)) + ' y el ' + esc(fmtShort(LAST_DAY)) + '. Puedes cambiarla hasta el día anterior a su llegada.</p></div><div class="shelf">';
  for(var n = 1; n <= MAX; n++){
    var b = myBottles().filter(function(x){ return x.slot === n; })[0];
    if(b){
      var ed = canEdit(b), tx = b.body || '';
      h += '<div class="slot' + (ed ? '' : ' locked') + '">' + bottleSVG('still', true) + '<div class="d">' + esc(fmtShort(b.arrive_on)) + '</div><div class="t">' + esc(tx.slice(0, 60)) + (tx.length > 60 ? '…' : '') + (b.has_photo ? ' 📷' : '') + '</div>' + (ed ? '<button class="btn small" data-edit="' + n + '">Editar</button>' : '<button class="btn small ghost" data-mine="' + n + '">Ya navegó · ver</button>') + '</div>';
    }else{
      h += '<div class="slot">' + bottleSVG('still', false) + '<div class="d">Botella vacía</div><button class="btn small" data-edit="' + n + '">Escribir</button></div>';
    }
  }
  return h + '</div><div class="plank"></div>';
}

function vRepisa(){
  var o = other(S.role), sh = shelfBottles(), h = '<div class="card"><h2>Repisa</h2><p class="muted">Aquí quedan las botellas de ' + esc(NAMES[o]) + ' de días anteriores, para releerlas cuando quieras.</p></div>';
  if(!sh.length) h += '<div class="card muted" style="text-align:center">Todavía no hay botellas en la repisa.</div>';
  else{
    h += '<div class="shelf">';
    sh.forEach(function(b, i){ h += '<div class="slot"><div class="d">Botella ' + (i + 1) + '</div>' + bottleSVG('still sunk', true) + '<div class="d">' + esc(fmtShort(b.arrive_on)) + '</div><button class="btn small" data-read="' + esc(b.id) + '">Leer</button></div>'; });
    h += '</div><div class="plank"></div>';
  }
  h += '<div class="card"><h2>Cuaderno de teorías</h2><p class="muted">Apunta aquí tus sospechas. Es privado: solo tú lo ves.</p><textarea id="note-in" maxlength="1000" placeholder="Creo que el regalo tiene que ver con…"></textarea><div class="row" style="margin-top:10px"><button class="btn small" id="note-add">Guardar nota</button></div>';
  S.notes.forEach(function(n){ h += '<div class="note"><small>' + esc(new Date(n.created_at).toLocaleString('es-PE', {timeZone:'America/Lima', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})) + ' · <a href="#" data-delnote="' + esc(n.id) + '" style="color:#f1b0a8">borrar</a></small>' + esc(n.body).replace(/\n/g, '<br>') + '</div>'; });
  return h + '</div>';
}

function vCofre(){
  var me = S.role, o = other(me), g = guessOf(me), h = '<div class="card"><h2>Cofre del tesoro</h2><p class="muted">Cuando creas haber descifrado las pistas, escribe qué crees que quiere ' + esc(NAMES[o]) + ' de regalo. Las dos respuestas se revelan el ' + esc(fmtDate(REVEAL)) + '.</p></div>';
  if(revealed()){
    h += '<div class="card"><h2>¡Se abre el cofre!</h2>';
    [me, o].forEach(function(r){ var x = guessOf(r); h += '<div class="note"><small>' + esc(NAMES[r]) + ' cree que ' + esc(NAMES[other(r)]) + ' quiere…</small>' + (x ? esc(x.body).replace(/\n/g, '<br>') : '<i class="muted">No dejó respuesta</i>') + '</div>'; });
    return h + '</div>';
  }
  h += '<div class="card"><label for="g-in" style="margin-top:0">Mi respuesta para ' + esc(NAMES[o]) + '</label><textarea id="g-in" maxlength="800" placeholder="Creo que le gustaría…">' + esc(g ? g.body : '') + '</textarea><div class="row" style="margin-top:10px"><button class="btn" id="g-save">' + (g ? 'Actualizar respuesta' : 'Guardar en el cofre') + '</button></div>';
  h += '<p class="muted" style="margin-top:12px">' + esc(NAMES[o]) + (hasGuessed(o) ? ' ya dejó su respuesta en el cofre.' : ' todavía no ha dejado su respuesta.') + '</p></div>';
  return h + '<div class="card muted" style="text-align:center">Se abre en <span id="cd2" class="count" style="font-size:22px"></span></div>';
}

/* ====== eventos ====== */
function bindHeader(){
  var ac = $('#acct'); if(ac) ac.onclick = account;
  var lg = $('#logo');
  if(lg && IS_TEST && S.serverRole){ var c = 0, tm; lg.onclick = function(){ c++; clearTimeout(tm); tm = setTimeout(function(){ c = 0; }, 1500); if(c >= 5){ c = 0; captain(); } }; }
}
function bind(){
  bindHeader();
  document.querySelectorAll('[data-tab]').forEach(function(b){ b.onclick = function(){ S.tab = b.getAttribute('data-tab'); render(); window.scrollTo(0, 0); }; });
  var ot = $('#open-today'); if(ot) ot.onclick = function(){ var b = todaysBottle(); if(b) showScroll(b); };
  var tb = $('#today-btl'); if(tb) tb.onclick = function(){ var b = todaysBottle(); if(b) showScroll(b); };
  document.querySelectorAll('[data-edit]').forEach(function(b){ b.onclick = function(){ editor(parseInt(b.getAttribute('data-edit'), 10)); }; });
  document.querySelectorAll('[data-mine]').forEach(function(b){ b.onclick = function(){ var n = parseInt(b.getAttribute('data-mine'), 10); var x = myBottles().filter(function(y){ return y.slot === n; })[0]; if(x) showScroll(x); }; });
  document.querySelectorAll('[data-read]').forEach(function(b){ b.onclick = function(){ var id = b.getAttribute('data-read'); var x = S.bottles.filter(function(y){ return y.id === id; })[0]; if(x) showScroll(x); }; });
  var na = $('#note-add');
  if(na) na.onclick = function(){
    var v = $('#note-in').value.trim(); if(!v) return;
    na.disabled = true;
    DB.addNote(v.slice(0, 1000)).then(function(){ $('#note-in').value = ''; toast('Nota guardada en tu cuaderno'); return refresh(); }).catch(function(e){ na.disabled = false; fail(e); });
  };
  document.querySelectorAll('[data-delnote]').forEach(function(a){ a.onclick = function(e){ e.preventDefault(); DB.delNote(a.getAttribute('data-delnote')).then(refresh).catch(fail); }; });
  var gs = $('#g-save');
  if(gs) gs.onclick = function(){
    var v = $('#g-in').value.trim(); if(!v){ toast('Escribe tu respuesta primero'); return; }
    gs.disabled = true;
    DB.saveGuess(v.slice(0, 800)).then(function(){ document.activeElement && document.activeElement.blur(); toast('Respuesta guardada en el cofre'); return refresh(); }).catch(function(e){ gs.disabled = false; fail(e); });
  };
}
var toastTm;
function toast(msg){ var old = $('.toast'); if(old) old.remove(); var d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; document.body.appendChild(d); clearTimeout(toastTm); toastTm = setTimeout(function(){ d.remove(); }, 3400); }

/* ====== modales ====== */
function openModal(inner){
  closeModal(true); modalOpen = true;
  var ov = document.createElement('div'); ov.className = 'ov'; ov.id = 'ov';
  ov.innerHTML = '<div class="sheet">' + inner + '</div>';
  ov.addEventListener('click', function(e){ if(e.target === ov) closeModal(); });
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-close]').forEach(function(b){ b.onclick = function(){ closeModal(); }; });
  return ov;
}
function closeModal(silent){ var ov = $('#ov'); if(ov) ov.remove(); modalOpen = false; if(!silent && S.dirty) setTimeout(safeRender, 50); }

function showScroll(b){
  var list = (b.author === S.role ? myBottles() : incoming()).map(function(x){ return x.id; });
  var n = list.indexOf(b.id) + 1;
  var ov = openModal('<div class="paper"><div class="seal">✉</div><h3>Mensaje de ' + esc(NAMES[b.author]) + '</h3><div class="date">' + esc(fmtDate(b.arrive_on)) + (n ? ' · botella ' + n : '') + '</div><div id="s-ph">' + (b.has_photo ? '<p class="muted"><i>Desenrollando la foto…</i></p>' : '') + '</div><div class="txt">' + esc(b.body) + '</div></div><div class="row" style="justify-content:center;margin-top:14px"><button class="btn ghost" data-close>Cerrar</button></div>');
  if(b.has_photo){
    getPhoto(b).then(function(p){
      var box = $('#s-ph', ov); if(!box) return; box.innerHTML = '';
      if(p){ var im = document.createElement('img'); im.className = 'ph'; im.alt = ''; im.src = p; box.appendChild(im); }
    }).catch(function(){ var box = $('#s-ph', ov); if(box) box.innerHTML = '<p class="muted">No se pudo cargar la foto.</p>'; });
  }
}

function imgToDataUrl(file){
  return new Promise(function(res, rej){
    var url = URL.createObjectURL(file), im = new Image();
    im.onload = function(){
      var tries = [[1000, .8], [900, .72], [800, .64], [700, .56], [560, .5]], out = '';
      for(var i = 0; i < tries.length; i++){
        var m = tries[i][0], s = Math.min(1, m / Math.max(im.width, im.height));
        var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.width * s)); c.height = Math.max(1, Math.round(im.height * s));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', tries[i][1]);
        if(out.length < 200000) break;
      }
      URL.revokeObjectURL(url);
      out.length < 280000 ? res(out) : rej(new Error('big'));
    };
    im.onerror = function(){ URL.revokeObjectURL(url); rej(new Error('img')); };
    im.src = url;
  });
}

function editor(n){
  var me = S.role, cur = myBottles().filter(function(x){ return x.slot === n; })[0] || null;
  var photo = cur && cur.has_photo ? 'keep' : null;
  var minD = minArrive();
  var ov = openModal('<div class="paper"><div class="seal">🍾</div><h3>Botella ' + n + ' para ' + esc(NAMES[other(me)]) + '</h3><p class="muted" style="margin:0 0 6px">Escribe una pista sin decir el regalo directamente.</p>' +
    '<label for="e-date">¿Qué día debe llegar a la orilla?</label><input type="date" id="e-date" min="' + minD + '" max="' + LAST_DAY + '" value="' + esc(cur ? cur.arrive_on : '') + '">' +
    '<label for="e-text">La pista</label><textarea id="e-text" maxlength="600" placeholder="Es algo que…">' + esc(cur ? cur.body : '') + '</textarea>' +
    '<label>Una foto (opcional)</label><div id="e-ph"></div><input type="file" id="e-file" accept="image/*" style="margin-top:8px">' +
    '<div class="row" style="margin-top:18px;justify-content:space-between"><button class="btn red" id="e-save">Sellar botella</button><button class="btn ghost dark" data-close>Cancelar</button></div>' +
    (cur ? '<p style="margin:14px 0 0"><a href="#" id="e-del" class="plink">Vaciar esta botella</a></p>' : '') + '</div>');
  function paintPh(src){
    var box = $('#e-ph', ov); box.innerHTML = '';
    if(!src) return;
    var im = document.createElement('img'); im.className = 'ph'; im.alt = ''; im.src = src; box.appendChild(im);
    var a = document.createElement('a'); a.href = '#'; a.textContent = 'Quitar foto'; a.className = 'plink';
    a.onclick = function(e){ e.preventDefault(); photo = null; paintPh(null); }; box.appendChild(a);
  }
  if(photo === 'keep'){ $('#e-ph', ov).innerHTML = '<p class="muted"><i>Cargando la foto…</i></p>'; getPhoto(cur).then(function(p){ if(photo === 'keep') paintPh(p); }).catch(function(){}); }
  $('#e-file', ov).onchange = function(e){ var f = e.target.files && e.target.files[0]; if(!f) return; imgToDataUrl(f).then(function(u){ photo = u; paintPh(u); }).catch(function(){ toast('No pude usar esa foto. Prueba con otra.'); }); };
  $('#e-save', ov).onclick = function(){
    var d = $('#e-date', ov).value, tx = $('#e-text', ov).value.trim();
    if(!tx){ toast('Escribe la pista'); return; }
    if(!d || d < LAUNCH || d > LAST_DAY){ toast('Elige un día entre el ' + fmtShort(LAUNCH) + ' y el ' + fmtShort(LAST_DAY)); return; }
    if(d < minD){ toast('Tiene que llegar desde el ' + fmtShort(minD) + ' en adelante'); return; }
    if(myBottles().some(function(x){ return x.slot !== n && x.arrive_on === d; })){ toast('Ya tienes otra botella ese día. Elige uno distinto.'); return; }
    var btn = $('#e-save', ov); btn.disabled = true; btn.textContent = 'Sellando…';
    DB.saveBottle(n, d, tx, photo).then(function(){ closeModal(true); toast('Botella sellada. ¡A navegar!'); return refresh(); }).catch(function(e){ btn.disabled = false; btn.textContent = 'Sellar botella'; fail(e); });
  };
  var del = $('#e-del', ov);
  if(del) del.onclick = function(e){
    e.preventDefault();
    if(del.getAttribute('data-sure') !== '1'){ del.setAttribute('data-sure', '1'); del.textContent = 'Toca otra vez para vaciarla'; return; }
    DB.delBottle(n).then(function(){ closeModal(true); toast('Botella vaciada'); return refresh(); }).catch(fail);
  };
}

function account(){
  var email = S.session && S.session.user && S.session.user.email || '';
  var ov = openModal('<div class="paper"><div class="seal">⚓</div><h3>' + esc(NAMES[S.serverRole] || 'Tripulante') + '</h3><p class="muted">' + esc(email) + '</p>' +
    '<div class="row" style="margin-top:14px;justify-content:space-between"><button class="btn red small" id="a-out">Cerrar sesión</button><button class="btn ghost dark small" data-close>Volver</button></div></div>');
  $('#a-out', ov).onclick = logout;
}

/* ====== camarote del capitán (solo en la versión de prueba) ====== */
function captain(){
  var f = lsGet(FAKE_KEY) || '';
  var ov = openModal('<div class="paper"><div class="seal">⚓</div><h3>Camarote del capitán</h3><p class="muted">Panel de pruebas. Viajar en el tiempo solo cambia este dispositivo.</p>' +
    '<label for="c-date">Viajar a otra fecha</label><input type="date" id="c-date" value="' + esc(f) + '">' +
    '<div class="row" style="margin-top:8px"><button class="btn small" id="c-set">Aplicar</button><button class="btn small ghost dark" id="c-real">Volver a hoy</button></div>' +
    '<hr class="sep dark"><label>Ver la app como</label><div class="row"><button class="btn small" data-as="jean">Jean</button><button class="btn small" data-as="paty">Paty</button><button class="btn small ghost dark" data-as="auto">Yo mismo</button></div>' +
    '<hr class="sep dark"><label>Limpiar la prueba</label><button class="btn small red" id="c-reset">Borrar todo lo de prueba</button><p class="muted" style="font-size:14px;margin:6px 0 0">Borra las botellas y respuestas de prueba de los dos, y tus notas de prueba. No toca el juego real.</p>' +
    '<div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn ghost dark small" data-close>Cerrar</button></div></div>');
  $('#c-set', ov).onclick = function(){ var v = $('#c-date', ov).value; if(!v) return; lsSet(FAKE_KEY, v); bootReal = Date.now(); closeModal(true); render(); };
  $('#c-real', ov).onclick = function(){ lsSet(FAKE_KEY, null); closeModal(true); render(); };
  ov.querySelectorAll('[data-as]').forEach(function(b){ b.onclick = function(){ var v = b.getAttribute('data-as'); lsSet(VIEWAS_KEY, v === 'auto' ? null : v); S.role = resolveRole(); closeModal(true); render(); }; });
  $('#c-reset', ov).onclick = function(){
    var btn = $('#c-reset', ov);
    if(btn.getAttribute('data-sure') !== '1'){ btn.setAttribute('data-sure', '1'); btn.textContent = 'Toca otra vez para confirmar'; return; }
    btn.disabled = true;
    DB.resetTest().then(function(){ closeModal(true); toast('Mar de prueba limpio.'); return refresh(); }).catch(function(e){ btn.disabled = false; fail(e); });
  };
}

/* ====== reloj en pantalla y actualización ====== */
var lastDay = '';
function tick(){
  var c = $('#cd'); if(c) c.textContent = hms(endOfDayMs() - nowMs());
  var c2 = $('#cd2'); if(c2){ var ms = Date.parse(REVEAL + 'T00:00:00-05:00') - nowMs(); var d = Math.floor(ms / 86400000); c2.textContent = (ms > 0 ? d + ' d ' + hms(ms - d * 86400000) : '¡ya!'); }
}
setInterval(function(){
  if(!S.ready || !S.session) return;
  var d = todayStr();
  if(lastDay && d !== lastDay){ lastDay = d; refresh(); return; }
  lastDay = d; tick();
}, 1000);
setInterval(function(){ if(S.session && document.visibilityState === 'visible') refresh(); }, 60000);
document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible' && S.session) refresh(); });

/* ====== portada ====== */
function seen(){ try{ return sessionStorage.getItem('mm_seen') === '1'; }catch(e){ return mem.mm_seen === '1'; } }
function splash(){
  var d = document.createElement('div'); d.className = 'splash';
  d.innerHTML = '<div class="cover"><h1>Mensajes al Mar</h1><div class="names">JEAN &amp; PATY</div><p>Cada día llegará una botella con una pista.<br>Descifren el tesoro de Navidad.</p><button class="btn" id="go">Zarpar</button></div>';
  document.body.appendChild(d);
  $('#go', d).onclick = function(){ d.remove(); try{ sessionStorage.setItem('mm_seen', '1'); }catch(e){ mem.mm_seen = '1'; } };
}

/* ====== arranque ====== */
function onSession(session){
  var was = S.session && S.session.user && S.session.user.id, now = session && session.user && session.user.id;
  S.session = session; S.authChecked = true;
  if(now && now !== was){ S.ready = false; render(); setTimeout(refresh, 0); }
  else if(!now){ S.ready = false; render(); }
}
render();
if(sb){
  sb.auth.getSession().then(function(r){ onSession(r.data && r.data.session || null); }).catch(function(){ S.authChecked = true; render(); });
  sb.auth.onAuthStateChange(function(ev, session){ setTimeout(function(){ if(ev === 'TOKEN_REFRESHED'){ S.session = session; return; } onSession(session); }, 0); });
}
if(!seen()) splash();
window.MM_DEBUG = {S:S, refresh:refresh};
})();
