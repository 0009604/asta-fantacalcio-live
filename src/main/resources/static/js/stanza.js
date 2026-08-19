// ---------------------------------------------------------------- SETUP

const params = new URLSearchParams(window.location.search);
const codiceStanza = (params.get('codice') || localStorage.getItem('fanta_codice') || '').toUpperCase();
const mioNome = params.get('nome') || localStorage.getItem('fanta_nome') || '';

if (!codiceStanza || !mioNome) {
  window.location.href = 'index.html';
}

localStorage.setItem('fanta_codice', codiceStanza);
localStorage.setItem('fanta_nome', mioNome);

document.getElementById('codiceStanzaLabel').textContent = codiceStanza;
document.getElementById('nomeLabel').textContent = mioNome;

const RUOLI = [
  { key: 'PORTIERE', label: 'Portieri', short: 'P', color: 'bg-amber-500/20 text-amber-300' },
  { key: 'DIFENSORE', label: 'Difensori', short: 'D', color: 'bg-sky-500/20 text-sky-300' },
  { key: 'CENTROCAMPISTA', label: 'Centrocampisti', short: 'C', color: 'bg-emerald-500/20 text-emerald-300' },
  { key: 'ATTACCANTE', label: 'Attaccanti', short: 'A', color: 'bg-rose-500/20 text-rose-300' },
];
const RUOLO_INFO = Object.fromEntries(RUOLI.map(r => [r.key, r]));
const SLOT_CONFIG_KEY = { PORTIERE: 'slotPortieri', DIFENSORE: 'slotDifensori', CENTROCAMPISTA: 'slotCentrocampisti', ATTACCANTE: 'slotAttaccanti' };

let ultimoStato = null;
let listinoSelezionato = null; // { nome, ruolo, squadra } se l'utente ha scelto un suggerimento
let valoreStaged = null;       // valore attualmente impostato sullo slider di rilancio
let ultimaOffertaVista = null; // per capire quando resettare lo slider (nuova offerta altrui)
let ultimoSecondoVibrato = null; // per non far vibrare più volte lo stesso secondo
let ultimoEventoAggiudicazioneVincitore = null; // per triggerare confetti solo al vincitore
let autoBidAttivo = false;
let autoBidMax = 50;
let autoBidOffertaPrecedente = null; // per rilevare quando qualcuno rilancia dopo di noi

// DIAL CONSTANTS
const DIAL_CX = 130, DIAL_CY = 130, DIAL_R = 110;
const DIAL_CIRC = 2 * Math.PI * DIAL_R;
const DIAL_ARC_DEG = 270;
const DIAL_ARC_LEN = DIAL_CIRC * (DIAL_ARC_DEG / 360);
const DIAL_START_DEG = 135;
let dialMin = 1, dialMax = 100;
let dialDragging = false;

// ---------------------------------------------------------------- AUDIO (beep locale, solo su azione propria)

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.35);
  } catch (e) { /* audio non disponibile, ignora */ }
}

// ---------------------------------------------------------------- AUDIO CASH (rilancio pesante)

const cashAudio = new Audio('/audio/cash.mp3');
cashAudio.volume = 0.45;
let cashInRiproduzione = false;
function playCash() {
  if (cashInRiproduzione) return;
  cashInRiproduzione = true;
  cashAudio.currentTime = 0;
  cashAudio.play().catch(() => {}).finally(() => { cashInRiproduzione = false; });
}

// ---------------------------------------------------------------- CONFETTI WINNER

function lanciaConfetti() {
  const overlay = document.getElementById('confettiOverlay');
  overlay.innerHTML = '';
  overlay.classList.remove('active', 'hidden');
  void overlay.offsetWidth; // force reflow per riattivare l'animazione
  overlay.classList.add('active');

  const emoji = ['🏆', '🎉', '⚽', '🍾', '✨', '🎊', '🥇', '🎆'];
  const count = 40;
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span');
    span.className = 'confetti-particle';
    span.textContent = emoji[Math.floor(Math.random() * emoji.length)];
    span.style.left = Math.random() * 100 + '%';
    span.style.setProperty('--fall-duration', (2 + Math.random() * 1.5) + 's');
    span.style.setProperty('--fall-delay', (Math.random() * 0.8) + 's');
    span.style.setProperty('--fall-spin', (360 + Math.random() * 720) + 'deg');
    span.style.fontSize = (1.2 + Math.random() * 1.8) + 'rem';
    overlay.appendChild(span);
  }

  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('active');
    overlay.innerHTML = '';
  }, 3800);
}

// ---------------------------------------------------------------- AUTOCOMPLETE LISTINO

let timeoutRicerca = null;
const inputNome = document.getElementById('inputNomeCalciatore');
const listaSuggerimenti = document.getElementById('listaSuggerimenti');

inputNome.addEventListener('input', () => {
  listinoSelezionato = null; // l'utente sta digitando di nuovo, il suggerimento precedente non è più valido
  const query = inputNome.value.trim();
  clearTimeout(timeoutRicerca);
  if (query.length < 2) {
    nascondiSuggerimenti();
    return;
  }
  timeoutRicerca = setTimeout(() => cercaListino(query), 250);
});

inputNome.addEventListener('blur', () => {
  // piccolo ritardo per permettere al click sul suggerimento di registrarsi prima di nascondere
  setTimeout(nascondiSuggerimenti, 150);
});

async function cercaListino(query) {
  try {
    const res = await fetch(`/api/listino/search?query=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    const risultati = await res.json();
    mostraSuggerimenti(risultati);
  } catch (e) { /* listino non raggiungibile, l'utente può comunque scrivere a mano */ }
}

function mostraSuggerimenti(risultati) {
  if (!risultati || risultati.length === 0) {
    nascondiSuggerimenti();
    return;
  }
  listaSuggerimenti.innerHTML = '';
  risultati.forEach(g => {
    const info = RUOLO_INFO[g.ruolo];
    const li = document.createElement('li');
    li.className = 'px-3 py-2 hover:bg-slate-700 cursor-pointer text-sm flex items-center justify-between gap-2';
    li.innerHTML = `
      <span class="truncate">${escapeHtml(g.nome)}</span>
      <span class="flex items-center gap-1.5 shrink-0">
        <span class="text-[10px] text-slate-500">${escapeHtml(g.squadra || '')}</span>
        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${info.color}">${info.short}</span>
      </span>
    `;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // evita che il blur dell'input scatti prima del click
      inputNome.value = g.nome;
      document.getElementById('selectRuolo').value = g.ruolo;
      listinoSelezionato = g;
      nascondiSuggerimenti();
    });
    listaSuggerimenti.appendChild(li);
  });
  listaSuggerimenti.classList.remove('hidden');
}

function nascondiSuggerimenti() {
  listaSuggerimenti.classList.add('hidden');
}

async function aggiornaStatoListino() {
  const el = document.getElementById('listinoStato');
  if (!el) return;
  try {
    const res = await fetch('/api/listino/stato');
    const stato = await res.json();
    if (stato.errore) {
      el.textContent = '⚠️ ' + stato.errore;
      el.className = 'text-xs text-rose-400 mb-2';
    } else {
      el.textContent = '✅ ' + stato.numeroGiocatori + ' giocatori caricati';
      el.className = 'text-xs text-emerald-400 mb-2';
    }
  } catch (e) {
    el.textContent = '⚠️ impossibile contattare il server';
    el.className = 'text-xs text-rose-400 mb-2';
  }
}
aggiornaStatoListino();

document.getElementById('btnRicaricaListino').addEventListener('click', async () => {
  const el = document.getElementById('listinoStato');
  el.textContent = 'ricarico...';
  el.className = 'text-xs text-slate-400 mb-2';
  try {
    await fetch('/api/listino/ricarica', { method: 'POST' });
  } catch (e) { /* ignora, aggiornaStatoListino mostrerà l'errore */ }
  aggiornaStatoListino();
});

// ---------------------------------------------------------------- TOAST EVENTI

function mostraToast(evento) {
  const area = document.getElementById('toastArea');
  const div = document.createElement('div');
  let stile = 'bg-slate-800 border-slate-700 text-slate-100';
  let durata = 2200;

  if (evento.tipo === 'SEI_LENTO') {
    stile = 'bg-rose-600 border-rose-500 text-white text-xl font-black';
    durata = 700;
  } else if (evento.tipo === 'ERRORE') {
    stile = 'bg-rose-900/90 border-rose-700 text-rose-100';
    durata = 2500;
  } else if (evento.tipo === 'AGGIUDICAZIONE') {
    stile = 'bg-emerald-600 border-emerald-500 text-white font-bold';
    durata = 3200;
  } else if (evento.tipo === 'SIMILE') {
    stile = 'bg-amber-500 border-amber-400 text-slate-950 font-semibold';
    durata = 2000;
  } else if (evento.tipo === 'STUZZICA') {
    stile = 'toast-stuzzica';
    durata = 4000;
  }

  div.className = `animate-toast pointer-events-auto border rounded-xl px-4 py-2.5 shadow-lg ${stile}`;
  div.textContent = evento.messaggio;
  area.appendChild(div);
  setTimeout(() => div.remove(), durata);
}

// ---------------------------------------------------------------- BACKUP AUTOMATICO

function salvaBackupRicevuto(backup) {
  try {
    localStorage.setItem('fanta_backup_' + codiceStanza, JSON.stringify(backup));
    const el = document.getElementById('backupStatoLabel');
    if (el) {
      const ora = new Date(backup.timestampMillis || Date.now());
      const hh = String(ora.getHours()).padStart(2, '0');
      const mm = String(ora.getMinutes()).padStart(2, '0');
      const ss = String(ora.getSeconds()).padStart(2, '0');
      el.textContent = '✅ ultimo backup: ' + hh + ':' + mm + ':' + ss;
      el.className = 'text-xs text-emerald-400 mb-2';
    }
  } catch (e) { /* storage pieno o non disponibile, non è grave */ }
}

document.getElementById('btnScaricaBackup').addEventListener('click', () => {
  const grezzo = localStorage.getItem('fanta_backup_' + codiceStanza);
  if (!grezzo) {
    alert('Nessun backup ancora disponibile: il primo arriva entro 60 secondi dall\'apertura della stanza.');
    return;
  }
  const blob = new Blob([grezzo], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const adesso = new Date();
  const timestamp = adesso.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `backup-${codiceStanza}-${timestamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------- QR CODE

document.getElementById('btnMostraQr').addEventListener('click', () => {
  const bloc = document.getElementById('blocQr');
  const giaVisibile = !bloc.classList.contains('hidden');
  if (giaVisibile) {
    bloc.classList.add('hidden');
    return;
  }
  bloc.classList.remove('hidden');

  const link = `${window.location.origin}/index.html?codice=${codiceStanza}`;
  document.getElementById('qrLinkTesto').textContent = link;

  const wrap = document.getElementById('qrCanvasWrap');
  wrap.innerHTML = '';
  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  if (window.QRCode) {
    QRCode.toCanvas(canvas, link, { width: 200, margin: 1 }, (err) => {
      if (err) wrap.textContent = 'Impossibile generare il QR, usa il link qui sotto.';
    });
  } else {
    wrap.textContent = 'QR non disponibile, usa il link qui sotto.';
  }
});

// ---------------------------------------------------------------- STOMP

const stompClient = new StompJs.Client({
  webSocketFactory: () => new SockJS('/ws'),
  reconnectDelay: 3000,
  heartbeatIncoming: 10000,
  heartbeatOutgoing: 10000,
});

stompClient.onConnect = () => {
  document.getElementById('dotConnessione').className = 'w-2 h-2 rounded-full bg-emerald-400 ml-1';
  // coda privata: qui arriva solo lo stato personalizzato per questo utente
  // (budget e rose degli altri partecipanti non ci vengono nemmeno inviati)
  stompClient.subscribe('/user/queue/stato', (msg) => {
    const dto = JSON.parse(msg.body);
    renderStato(dto);
  });
  // backup automatico ogni 60s, arriva solo se sei l'admin della stanza
  stompClient.subscribe('/user/queue/backup', (msg) => {
    const backup = JSON.parse(msg.body);
    salvaBackupRicevuto(backup);
  });
  stompClient.publish({
    destination: `/app/stanza/${codiceStanza}/join`,
    body: JSON.stringify({ nome: mioNome })
  });
};

stompClient.onDisconnect = () => {
  document.getElementById('dotConnessione').className = 'w-2 h-2 rounded-full bg-amber-400 ml-1';
};

stompClient.onWebSocketClose = () => {
  document.getElementById('dotConnessione').className = 'w-2 h-2 rounded-full bg-rose-500 ml-1';
};

stompClient.activate();

// ---------------------------------------------------------------- RENDER

function renderStato(dto) {
  ultimoStato = dto;

  const me = dto.partecipanti.find(u => u.nome.toLowerCase() === mioNome.toLowerCase());
  const sonoAdmin = !!(me && me.admin);

  if (me) {
    document.getElementById('budgetLabel').textContent = me.budgetResiduo;
    renderRosa(me.rosa, dto.configurazione);
    document.getElementById('pannelloAdmin').classList.toggle('hidden', !sonoAdmin);
    if (sonoAdmin) {
      document.getElementById('timerInput').value = dto.configurazione.timerSecondi;
    }
  }

  renderPartecipanti(dto.partecipanti, dto.adminNome, dto.astaCorrente);
  renderLog(dto.log);
  renderPiatto(dto.astaCorrente, dto.configurazione, me);
  renderPausa(dto.inPausa, sonoAdmin);

  if (sonoAdmin && dto.inPausa) {
    renderGestioneRose(dto.partecipanti);
    document.getElementById('pannelloGestioneRose').classList.remove('hidden');
  } else {
    document.getElementById('pannelloGestioneRose').classList.add('hidden');
  }

  if (dto.evento && (dto.evento.targetNome == null || dto.evento.targetNome.toLowerCase() === mioNome.toLowerCase())) {
    if (dto.evento.tipo === 'AUDIO_CASH') {
      playCash();
    } else {
      mostraToast(dto.evento);
    }

    if (dto.evento.tipo === 'AGGIUDICAZIONE' && dto.evento.messaggio) {
      const nomeVincitore = dto.evento.messaggio.split(' ')[0];
      if (nomeVincitore && nomeVincitore.toLowerCase() === mioNome.toLowerCase()) {
        lanciaConfetti();
      }
    }
  }

  gestisciAutoBid(dto);
}

function renderPausa(inPausa, sonoAdmin) {
  document.getElementById('bannerPausa').classList.toggle('hidden', !inPausa);

  const btn = document.getElementById('btnTogglePausa');
  if (sonoAdmin) {
    btn.textContent = inPausa ? '▶ Riprendi asta' : '⏸ Metti in pausa';
    btn.className = inPausa
      ? 'w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-2 rounded-lg text-sm mb-3'
      : 'w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2 rounded-lg text-sm mb-3';
  }

  // durante la pausa, blocca chiamate e rilanci per tutti
  const formChiamata = document.getElementById('formChiamata');
  formChiamata.querySelectorAll('input, select, button').forEach(el => el.disabled = inPausa);
  formChiamata.classList.toggle('opacity-50', inPausa);

  ['btnRilancioRapido', 'btnConfermaDial'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = inPausa;
      el.classList.toggle('opacity-40', inPausa);
      el.classList.toggle('cursor-not-allowed', inPausa);
    }
  });
  const dialHandle = document.getElementById('dialHandle');
  if (dialHandle) {
    dialHandle.style.pointerEvents = inPausa ? 'none' : 'auto';
    dialHandle.classList.toggle('opacity-40', inPausa);
  }
}

function renderPartecipanti(partecipanti, adminNome, astaCorrente) {
  const ul = document.getElementById('listaPartecipanti');
  ul.innerHTML = '';
  const astaAttiva = !!(astaCorrente && astaCorrente.attiva);
  partecipanti.forEach(u => {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between gap-2';
    const isMe = u.nome.toLowerCase() === mioNome.toLowerCase();
    li.innerHTML = `
      <span class="flex items-center gap-1.5 truncate">
        <span class="w-1.5 h-1.5 rounded-full ${u.connesso ? 'bg-emerald-400' : 'bg-slate-600'}"></span>
        <span class="truncate ${isMe ? 'font-bold text-emerald-400' : ''}">${escapeHtml(u.nome)}</span>
        ${u.admin ? '<span class="text-[10px] text-amber-400">★</span>' : ''}
      </span>
      <span class="flex items-center gap-2">
        <span class="text-slate-400 font-mono text-xs">${u.budgetResiduo === null || u.budgetResiduo === undefined ? '🔒' : u.budgetResiduo}</span>
        ${!isMe && u.connesso ? `<button class="btn-stuzzica" data-target="${escapeAttr(u.nome)}" title="Stuzzica!" ${astaAttiva ? 'disabled' : ''}>💬</button>` : ''}
      </span>
    `;
    ul.appendChild(li);
  });

  ul.querySelectorAll('.btn-stuzzica').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (!target || btn.disabled) return;
      beep();
      stompClient.publish({
        destination: `/app/stanza/${codiceStanza}/stuzzica`,
        body: JSON.stringify({ nomeDestinatario: target })
      });
    });
  });
}

function renderLog(log) {
  const ul = document.getElementById('listaLog');
  ul.innerHTML = '';
  log.forEach(riga => {
    const li = document.createElement('li');
    li.textContent = riga;
    ul.appendChild(li);
  });
}

function renderRosa(rosa, config) {
  const container = document.getElementById('rosaContainer');
  container.innerHTML = '';
  RUOLI.forEach(r => {
    const giocatori = rosa[r.key] || [];
    const slotTotali = config[SLOT_CONFIG_KEY[r.key]];
    const spesa = giocatori.reduce((sum, g) => sum + (g.prezzoPagato || 0), 0);
    const block = document.createElement('div');
    block.innerHTML = `
      <h3 class="text-xs font-bold uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
        <span class="px-1.5 py-0.5 rounded ${r.color}">${r.short}</span>
        <span class="text-slate-400">${r.label}</span>
        <span class="text-slate-600 ml-auto">${giocatori.length}/${slotTotali} <span class="text-slate-500">(${spesa} cr.)</span></span>
      </h3>
      <ul class="space-y-1 text-sm mb-3"></ul>
    `;
    const ul = block.querySelector('ul');
    for (let i = 0; i < slotTotali; i++) {
      const g = giocatori[i];
      const li = document.createElement('li');
      if (g) {
        li.className = 'flex justify-between bg-slate-800/60 rounded-lg px-2 py-1';
        li.innerHTML = `<span class="truncate">${escapeHtml(g.nome)}</span><span class="text-emerald-400 font-mono">${g.prezzoPagato}</span>`;
      } else {
        li.className = 'flex justify-between border border-dashed border-slate-800 rounded-lg px-2 py-1 text-slate-700';
        li.innerHTML = `<span>slot libero</span>`;
      }
      ul.appendChild(li);
    }
    container.appendChild(block);
  });
}

function renderGestioneRose(partecipanti) {
  const select = document.getElementById('selectSquadraGestione');
  const selezionatoPrima = select.value;
  select.innerHTML = '';
  partecipanti.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.nome;
    opt.textContent = u.nome;
    select.appendChild(opt);
  });
  if (selezionatoPrima && partecipanti.some(u => u.nome === selezionatoPrima)) {
    select.value = selezionatoPrima;
  }

  disegnaGestioneRosaSquadra(partecipanti);
  select.onchange = () => disegnaGestioneRosaSquadra(partecipanti);
}

function disegnaGestioneRosaSquadra(partecipanti) {
  const nomeSelezionato = document.getElementById('selectSquadraGestione').value;
  const utente = partecipanti.find(u => u.nome === nomeSelezionato);
  const container = document.getElementById('listaGestioneRosa');
  container.innerHTML = '';
  if (!utente) return;

  RUOLI.forEach(r => {
    const giocatori = utente.rosa[r.key] || [];
    if (giocatori.length === 0) return;

    const titolo = document.createElement('div');
    titolo.className = 'font-bold text-slate-400 uppercase mt-2';
    titolo.textContent = r.label;
    container.appendChild(titolo);

    giocatori.forEach((g, indice) => {
      const riga = document.createElement('div');
      riga.className = 'flex items-center gap-1 bg-slate-800/60 rounded-lg p-1.5';
      riga.innerHTML = `
        <input type="text" value="${escapeAttr(g.nome)}" class="gr-nome flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-xs">
        <input type="number" value="${g.prezzoPagato}" min="1" class="gr-prezzo w-14 bg-slate-900 border border-slate-700 rounded px-1 py-1 text-xs text-center">
        <button class="gr-salva bg-emerald-600 hover:bg-emerald-500 text-white rounded px-1.5 py-1 text-[10px] font-bold">OK</button>
        <button class="gr-elimina bg-rose-700 hover:bg-rose-600 text-white rounded px-1.5 py-1 text-[10px] font-bold">✕</button>
      `;

      riga.querySelector('.gr-salva').addEventListener('click', () => {
        const nuovoNome = riga.querySelector('.gr-nome').value.trim();
        const nuovoPrezzo = parseInt(riga.querySelector('.gr-prezzo').value, 10);
        stompClient.publish({
          destination: `/app/stanza/${codiceStanza}/admin/modificaRosa`,
          body: JSON.stringify({
            nomeSquadra: nomeSelezionato, ruolo: r.key, indice,
            rimuovi: false, nuovoNome, nuovoPrezzo
          })
        });
      });

      riga.querySelector('.gr-elimina').addEventListener('click', () => {
        if (!confirm(`Eliminare ${g.nome} dalla rosa di ${nomeSelezionato}? Il prezzo verrà rimborsato.`)) return;
        stompClient.publish({
          destination: `/app/stanza/${codiceStanza}/admin/modificaRosa`,
          body: JSON.stringify({ nomeSquadra: nomeSelezionato, ruolo: r.key, indice, rimuovi: true })
        });
      });

      container.appendChild(riga);
    });
  });

  if (container.innerHTML === '') {
    container.innerHTML = '<p class="text-slate-600">Rosa ancora vuota.</p>';
  }
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

function renderPiatto(asta, config, me) {
  const vuoto = document.getElementById('piattoVuoto');
  const attivo = document.getElementById('piattoAttivo');
  const btnChiama = document.getElementById('btnChiama');

  if (!asta || !asta.attiva) {
    vuoto.classList.remove('hidden');
    attivo.classList.add('hidden');
    btnChiama.disabled = false;
    btnChiama.classList.remove('opacity-40', 'cursor-not-allowed');
    ultimoSecondoVibrato = null;
    autoBidOffertaPrecedente = null;
    return;
  }

  vuoto.classList.add('hidden');
  attivo.classList.remove('hidden');
  btnChiama.disabled = true;
  btnChiama.classList.add('opacity-40', 'cursor-not-allowed');

  const info = RUOLO_INFO[asta.ruolo];
  const badge = document.getElementById('badgeRuolo');
  badge.textContent = info.short + ' · ' + capitalize(asta.ruolo);
  badge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ' + info.color;

  document.getElementById('nomeCalciatoreCorrente').textContent = asta.calciatoreNome;
  document.getElementById('squadraCalciatore').textContent = asta.squadra ? '(' + asta.squadra + ')' : '';
  document.getElementById('offertaCorrenteLabel').textContent = asta.offertaCorrente;

  const totale = Math.max(config.timerSecondi, 1);
  const frazione = Math.max(0, Math.min(1, asta.secondiRimanenti / totale));
  const inCritico = asta.secondiRimanenti <= 2;
  const coloreTimer = inCritico ? '#dc2626' : '#b45309';

  const secondiLabel = document.getElementById('secondiLabel');
  secondiLabel.textContent = asta.secondiRimanenti + ' s';
  secondiLabel.style.color = coloreTimer;

  const barra = document.getElementById('barraTimer');
  barra.style.width = (frazione * 100).toFixed(1) + '%';
  barra.style.background = coloreTimer;

  // vibrazione negli ultimi 3 secondi (solo Android/Chrome: iOS Safari non supporta l'API)
  if (asta.secondiRimanenti <= 3 && asta.secondiRimanenti >= 1) {
    if (asta.secondiRimanenti !== ultimoSecondoVibrato) {
      ultimoSecondoVibrato = asta.secondiRimanenti;
      if (navigator.vibrate) navigator.vibrate(150);
    }
  } else {
    ultimoSecondoVibrato = null;
  }

  const sonoIoInTesta = me && asta.offerenteNome && asta.offerenteNome.toLowerCase() === mioNome.toLowerCase();
  const offerenteWrap = document.getElementById('offerenteWrap');
  if (sonoIoInTesta) {
    offerenteWrap.innerHTML = '<span class="text-emerald-400 font-bold">🎉 SEI IN TESTA</span>';
  } else {
    offerenteWrap.innerHTML = 'è in testa <span class="text-lg font-bold text-slate-100">' + escapeHtml(asta.offerenteNome) + '</span>';
  }

  aggiornaDial(asta, config, me, sonoIoInTesta);
}

function calcolaOffertaMassima(me, config) {
  if (!me) return 0;
  let slotLiberiTotali = 0;
  RUOLI.forEach(r => {
    const usati = (me.rosa[r.key] || []).length;
    const totaliRuolo = config[SLOT_CONFIG_KEY[r.key]];
    slotLiberiTotali += Math.max(0, totaliRuolo - usati);
  });
  if (slotLiberiTotali <= 0) return 0;
  return me.budgetResiduo - (slotLiberiTotali - 1);
}

// ---------------------------------------------------------------- DIAL HELPERS

function dialFracToAngle(frac) {
  return DIAL_START_DEG + frac * DIAL_ARC_DEG;
}

function dialFracToXY(frac) {
  const rad = dialFracToAngle(frac) * Math.PI / 180;
  return { x: DIAL_CX + DIAL_R * Math.cos(rad), y: DIAL_CY + DIAL_R * Math.sin(rad) };
}

function aggiornaDialVisual(frac) {
  const progress = document.getElementById('dialProgress');
  const handle = document.getElementById('dialHandle');
  const arcLen = Math.max(0, frac * DIAL_ARC_LEN);
  progress.setAttribute('stroke-dasharray', arcLen + ' ' + DIAL_CIRC);
  const pos = dialFracToXY(frac);
  const wrap = document.getElementById('dialWrap');
  const vw = wrap.offsetWidth, vh = wrap.offsetHeight;
  handle.style.left = (pos.x / 260 * vw) + 'px';
  handle.style.top = (pos.y / 260 * vh) + 'px';
}

function aggiornaDial(asta, config, me, sonoIoInTesta) {
  const min = asta.offertaCorrente + 1;
  const max = calcolaOffertaMassima(me, config);
  dialMin = min;
  dialMax = max;

  const slotUsatiRuolo = (me && me.rosa[asta.ruolo]) ? me.rosa[asta.ruolo].length : 0;
  const slotTotaliRuolo = config[SLOT_CONFIG_KEY[asta.ruolo]];
  const haSlotLiberi = slotTotaliRuolo - slotUsatiRuolo > 0;
  const disabilitato = !!sonoIoInTesta || !haSlotLiberi || max < min;

  const handle = document.getElementById('dialHandle');
  const btnConf = document.getElementById('btnConfermaDial');
  const btnRapido = document.getElementById('btnRilancioRapido');
  const valoreTxt = document.getElementById('dialValoreTxt');
  const progress = document.getElementById('dialProgress');

  if (disabilitato) {
    handle.style.opacity = '0.3';
    handle.style.pointerEvents = 'none';
    btnConf.disabled = true;
    btnConf.classList.add('opacity-40', 'cursor-not-allowed');
    btnRapido.disabled = true;
    btnRapido.classList.add('opacity-40', 'cursor-not-allowed');
    valoreTxt.textContent = '\u2014';
    aggiornaDialVisual(0);
    progress.setAttribute('stroke', '#475569');
    document.getElementById('dialOfferenteTxt').textContent = !haSlotLiberi ? 'ruolo pieno' : (max < min ? 'budget insufficiente' : '');
    return;
  }

  handle.style.opacity = '1';
  handle.style.pointerEvents = 'auto';
  btnConf.disabled = false;
  btnConf.classList.remove('opacity-40', 'cursor-not-allowed');
  btnRapido.disabled = false;
  btnRapido.classList.remove('opacity-40', 'cursor-not-allowed');
  progress.setAttribute('stroke', sonoIoInTesta ? '#10b981' : '#0ea5e9');

  if (ultimaOffertaVista !== asta.offertaCorrente) {
    ultimaOffertaVista = asta.offertaCorrente;
    valoreStaged = min;
  }
  valoreStaged = Math.min(Math.max(valoreStaged, min), max);

  const frac = Math.max(0, Math.min(1, (valoreStaged - min) / (max - min)));
  aggiornaDialVisual(frac);

  valoreTxt.textContent = valoreStaged;
  btnConf.textContent = 'CONFERMA RILANCIO (' + valoreStaged + ' cr.)';

  const offerenteTxt = document.getElementById('dialOfferenteTxt');
  if (sonoIoInTesta) {
    offerenteTxt.textContent = '\uD83C\uDFC6 SEI IN TESTA';
    offerenteTxt.setAttribute('fill', '#10b981');
  } else {
    offerenteTxt.textContent = asta.offerenteNome ? ('in testa: ' + asta.offerenteNome) : '';
    offerenteTxt.setAttribute('fill', '#94a3b8');
  }
}

// ---------------------------------------------------------------- CALCOLO TETTO SICUREZZA

function calcolaTettoSicurezza(me, config) {
  if (!me) return 0;
  let slotLiberiRuolo = 0;
  RUOLI.forEach(r => {
    const usati = (me.rosa[r.key] || []).length;
    const totali = config[SLOT_CONFIG_KEY[r.key]];
    slotLiberiRuolo += Math.max(0, totali - usati);
  });
  if (slotLiberiRuolo <= 0) return 0;
  return me.budgetResiduo - (slotLiberiRuolo - 1);
}

// ---------------------------------------------------------------- OFFERTA AUTOMATICA

function gestisciAutoBid(dto) {
  const statusEl = document.getElementById('autoBidStatus');
  const ceilingEl = document.getElementById('autoBidCeiling');
  if (!statusEl) return;

  const me = dto.partecipanti.find(u => u.nome.toLowerCase() === mioNome.toLowerCase());
  if (!me) return;

  const tetto = calcolaTettoSicurezza(me, dto.configurazione);
  if (ceilingEl) {
    ceilingEl.textContent = 'Tetto sicurezza: ' + tetto + ' cr. (budget ' + me.budgetResiduo + ' - (slot liberi - 1))';
  }

  if (!autoBidAttivo || !dto.astaCorrente || !dto.astaCorrente.attiva || dto.inPausa) {
    statusEl.classList.add('hidden');
    autoBidOffertaPrecedente = null;
    return;
  }

  const asta = dto.astaCorrente;
  const sonoInTesta = asta.offerenteNome && asta.offerenteNome.toLowerCase() === mioNome.toLowerCase();

  if (sonoInTesta) {
    statusEl.textContent = '\u2705 Sei in testa \u2014 in attesa...';
    statusEl.className = 'text-[10px] text-emerald-400 mt-1 font-semibold';
    statusEl.classList.remove('hidden');
    autoBidOffertaPrecedente = asta.offertaCorrente;
    return;
  }

  if (autoBidOffertaPrecedente !== null && asta.offertaCorrente > autoBidOffertaPrecedente) {
    const prossimoRilancio = asta.offertaCorrente + 1;
    if (prossimoRilancio <= autoBidMax && prossimoRilancio <= tetto) {
      statusEl.textContent = '\u26A1 Rilancio automatico a ' + prossimoRilancio + ' cr.!';
      statusEl.className = 'text-[10px] text-amber-400 mt-1 font-semibold';
      statusEl.classList.remove('hidden');
      autoBidOffertaPrecedente = prossimoRilancio;
      beep();
      stompClient.publish({
        destination: '/app/stanza/' + codiceStanza + '/rilancio',
        body: JSON.stringify({ importo: prossimoRilancio })
      });
      return;
    } else {
      statusEl.textContent = '\u26D4 Tetto raggiunto (' + prossimoRilancio + ' > ' + Math.min(autoBidMax, tetto) + ')';
      statusEl.className = 'text-[10px] text-rose-400 mt-1 font-semibold';
      statusEl.classList.remove('hidden');
      autoBidOffertaPrecedente = null;
      return;
    }
  }

  autoBidOffertaPrecedente = asta.offertaCorrente;
  statusEl.textContent = '\u23F3 In attesa di rilancio...';
  statusEl.className = 'text-[10px] text-violet-400 mt-1 font-semibold';
  statusEl.classList.remove('hidden');
}

// ---------------------------------------------------------------- AUTOBID TOGGLE SETUP

// ---------------------------------------------------------------- AZIONI

document.getElementById('formChiamata').addEventListener('submit', (e) => {
  e.preventDefault();
  const nomeCalciatore = document.getElementById('inputNomeCalciatore').value.trim();
  const ruolo = document.getElementById('selectRuolo').value;
  const prezzoBase = parseInt(document.getElementById('inputPrezzoBase').value || '1', 10);
  if (!nomeCalciatore) return;

  beep();
  stompClient.publish({
    destination: `/app/stanza/${codiceStanza}/chiamata`,
    body: JSON.stringify({ nomeCalciatore, ruolo, prezzoBase })
  });
  document.getElementById('inputNomeCalciatore').value = '';
  document.getElementById('inputPrezzoBase').value = 1;
  listinoSelezionato = null;
  nascondiSuggerimenti();
});

document.getElementById('btnRilancioRapido').addEventListener('click', () => {
  beep();
  stompClient.publish({
    destination: '/app/stanza/' + codiceStanza + '/rilancio',
    body: JSON.stringify({ importo: null })
  });
});

// ---------------------------------------------------------------- DIAL INTERACTION

(function initDial() {
  const wrap = document.getElementById('dialWrap');
  if (!wrap) return;

  function handleInput(clientX, clientY) {
    const rect = wrap.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let deg = Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI;
    if (deg < 0) deg += 360;

    let rel = deg - DIAL_START_DEG;
    if (rel < 0) rel += 360;
    if (rel > DIAL_ARC_DEG) return;

    const min = dialMin, max = dialMax;
    if (max < min) return;

    const frac = rel / DIAL_ARC_DEG;
    valoreStaged = Math.round(min + frac * (max - min));
    valoreStaged = Math.min(Math.max(valoreStaged, min), max);

    aggiornaDialVisual(frac);
    document.getElementById('dialValoreTxt').textContent = valoreStaged;
    document.getElementById('btnConfermaDial').textContent = 'CONFERMA RILANCIO (' + valoreStaged + ' cr.)';
  }

  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dialDragging = true;
    handleInput(e.clientX, e.clientY);
    const onMove = (ev) => { if (dialDragging) handleInput(ev.clientX, ev.clientY); };
    const onUp = () => { dialDragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  wrap.addEventListener('touchstart', (e) => {
    e.preventDefault();
    dialDragging = true;
    if (e.touches[0]) handleInput(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  wrap.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (dialDragging && e.touches[0]) handleInput(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  wrap.addEventListener('touchend', () => { dialDragging = false; });
})();

document.getElementById('btnConfermaDial').addEventListener('click', () => {
  if (!valoreStaged) return;
  beep();
  stompClient.publish({
    destination: '/app/stanza/' + codiceStanza + '/rilancio',
    body: JSON.stringify({ importo: valoreStaged })
  });
});

document.getElementById('btnTimerSalva').addEventListener('click', () => {
  const secondi = parseInt(document.getElementById('timerInput').value, 10);
  if (!secondi) return;
  stompClient.publish({
    destination: `/app/stanza/${codiceStanza}/timer`,
    body: JSON.stringify({ secondi })
  });
});

document.getElementById('btnTogglePausa').addEventListener('click', () => {
  const inPausaOra = ultimoStato && ultimoStato.inPausa;
  stompClient.publish({
    destination: `/app/stanza/${codiceStanza}/pausa`,
    body: JSON.stringify({ pausa: !inPausaOra })
  });
});

document.getElementById('btnScaricaMiaJson').addEventListener('click', () => {
  window.location.href = `/api/stanze/${codiceStanza}/rosa?nome=${encodeURIComponent(mioNome)}&formato=json`;
});
document.getElementById('btnScaricaMiaTxt').addEventListener('click', () => {
  window.location.href = `/api/stanze/${codiceStanza}/rosa?nome=${encodeURIComponent(mioNome)}&formato=txt`;
});
document.getElementById('btnScaricaTutteJson').addEventListener('click', () => {
  window.location.href = `/api/stanze/${codiceStanza}/rosa-tutte?nomeRichiedente=${encodeURIComponent(mioNome)}&formato=json`;
});
document.getElementById('btnScaricaTutteTxt').addEventListener('click', () => {
  window.location.href = `/api/stanze/${codiceStanza}/rosa-tutte?nomeRichiedente=${encodeURIComponent(mioNome)}&formato=txt`;
});

// ---------------------------------------------------------------- AUTOBID COMPACT MODE

document.getElementById('btnAutoBidAttiva').addEventListener('click', () => {
  const input = document.getElementById('autoBidMaxInput');
  const maxVal = parseInt(input.value, 10);
  if (!maxVal || maxVal < 1) return;

  autoBidMax = maxVal;
  autoBidAttivo = true;
  autoBidOffertaPrecedente = null;

  document.getElementById('autoBidInactive').classList.add('hidden');
  document.getElementById('autoBidActive').classList.remove('hidden');
  document.getElementById('autoBidActive').classList.add('flex');
  document.getElementById('autoBidBadgeText').textContent = 'Auto-bid fino a ' + maxVal + ' cr';
});

document.getElementById('btnAutoBidAnnulla').addEventListener('click', () => {
  autoBidAttivo = false;
  autoBidOffertaPrecedente = null;

  document.getElementById('autoBidInactive').classList.remove('hidden');
  document.getElementById('autoBidActive').classList.add('hidden');
  document.getElementById('autoBidActive').classList.remove('flex');
  document.getElementById('autoBidStatus').classList.add('hidden');
});

// ---------------------------------------------------------------- UTIL

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalize(str) {
  return str.charAt(0) + str.slice(1).toLowerCase();
}
