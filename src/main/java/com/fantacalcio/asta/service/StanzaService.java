package com.fantacalcio.asta.service;

import com.fantacalcio.asta.dto.*;
import com.fantacalcio.asta.model.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

@Service
public class StanzaService {

    private static final String ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente 0/O/1/I ambigui
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Map<String, StanzaAsta> stanze = new ConcurrentHashMap<>();
    // sessionId websocket (in realtà l'identità di connessione assegnata da WebSocketConfig) -> [codiceStanza, nomeUtente]
    private final Map<String, String[]> sessioni = new ConcurrentHashMap<>();

    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);
    private final SimpMessagingTemplate messagingTemplate;
    private final ListinoService listinoService;

    public StanzaService(SimpMessagingTemplate messagingTemplate, ListinoService listinoService) {
        this.messagingTemplate = messagingTemplate;
        this.listinoService = listinoService;
        // backup automatico: ogni 60s, mandato in privato al solo admin di ogni stanza attiva
        scheduler.scheduleAtFixedRate(this::eseguiBackupPeriodico, 60, 60, TimeUnit.SECONDS);
    }

    // ---------------------------------------------------------------- EXPORT ROSE

    public UtenteDTO getRosaUtente(String codice, String nome) {
        StanzaAsta stanza = getStanza(codice);
        if (stanza == null) return null;
        stanza.getLock().lock();
        try {
            Utente u = trovaUtentePerNome(stanza, nome);
            return u == null ? null : UtenteDTO.from(u, true);
        } finally {
            stanza.getLock().unlock();
        }
    }

    public List<UtenteDTO> getTutteLeRose(String codice) {
        StanzaAsta stanza = getStanza(codice);
        if (stanza == null) return null;
        stanza.getLock().lock();
        try {
            List<UtenteDTO> lista = new ArrayList<>();
            for (Utente u : stanza.getUtenti().values()) {
                lista.add(UtenteDTO.from(u, true));
            }
            return lista;
        } finally {
            stanza.getLock().unlock();
        }
    }

    public boolean isAdmin(String codice, String nome) {
        StanzaAsta stanza = getStanza(codice);
        return stanza != null && nome != null && nome.trim().equalsIgnoreCase(stanza.getAdminNome());
    }

    // ---------------------------------------------------------------- CREAZIONE

    public String creaStanza(ConfigurazioneAsta configurazione, String nomeAdmin) {
        String codice;
        do {
            codice = generaCodice();
        } while (stanze.containsKey(codice));

        StanzaAsta stanza = new StanzaAsta(codice, configurazione, nomeAdmin.trim());
        stanze.put(codice, stanza);
        return codice;
    }

    private String generaCodice() {
        StringBuilder sb = new StringBuilder(6);
        for (int i = 0; i < 6; i++) {
            sb.append(ALFABETO.charAt(RANDOM.nextInt(ALFABETO.length())));
        }
        return sb.toString();
    }

    public boolean esisteStanza(String codice) {
        return stanze.containsKey(normalizza(codice));
    }

    public StanzaAsta getStanza(String codice) {
        return stanze.get(normalizza(codice));
    }

    private String normalizza(String codice) {
        return codice == null ? null : codice.trim().toUpperCase();
    }

    // ---------------------------------------------------------------- RIPRISTINO DA BACKUP

    /**
     * Crea una nuova stanza a partire da un backup scaricato in precedenza: stesso admin,
     * stessa configurazione, stessi partecipanti con budget e rose come li avevano lasciati.
     * I partecipanti dovranno rientrare usando lo stesso nome fantasquadra di prima.
     */
    public String ripristinaStanza(BackupStanzaDTO backup) {
        if (backup == null || backup.getConfigurazione() == null
                || backup.getAdminNome() == null || backup.getAdminNome().isBlank()) {
            return null;
        }

        String nuovoCodice;
        do {
            nuovoCodice = generaCodice();
        } while (stanze.containsKey(nuovoCodice));

        StanzaAsta stanza = new StanzaAsta(nuovoCodice, backup.getConfigurazione(), backup.getAdminNome().trim());

        if (backup.getUtenti() != null) {
            for (UtenteDTO u : backup.getUtenti()) {
                if (u.getNome() == null || u.getNome().isBlank()) continue;
                int budget = u.getBudgetResiduo() != null ? u.getBudgetResiduo() : backup.getConfigurazione().getBudgetIniziale();
                Utente utente = new Utente(u.getNome().trim(), budget, u.isAdmin());
                if (u.getRosa() != null) {
                    for (Map.Entry<Ruolo, List<Calciatore>> entry : u.getRosa().entrySet()) {
                        if (entry.getValue() != null) {
                            utente.getRosa().get(entry.getKey()).addAll(entry.getValue());
                        }
                    }
                }
                stanza.getUtenti().put(utente.getNome().toLowerCase(), utente);
            }
        }

        if (backup.getLog() != null) {
            // riaggiunti in ordine inverso per preservare l'ordine cronologico (aggiungiLog mette in testa)
            for (int i = backup.getLog().size() - 1; i >= 0; i--) {
                stanza.aggiungiLog(backup.getLog().get(i));
            }
        }
        stanza.aggiungiLog("♻️ Stanza ripristinata da backup (codice originale: " + backup.getCodiceOriginale() + ").");

        stanze.put(nuovoCodice, stanza);
        return nuovoCodice;
    }

    // ---------------------------------------------------------------- JOIN

    public void join(String codiceStanza, String nomeRichiesto, String sessionId) {
        StanzaAsta stanza = getStanza(codiceStanza);
        if (stanza == null || nomeRichiesto == null || nomeRichiesto.isBlank()) {
            return;
        }
        String nome = nomeRichiesto.trim();
        String chiave = nome.toLowerCase();

        stanza.getLock().lock();
        try {
            Utente utente = stanza.getUtenti().get(chiave);
            boolean isAdmin = nome.equalsIgnoreCase(stanza.getAdminNome());

            if (utente != null) {
                // riconnessione: stesso nome, ripristina sessione e stato (budget/rosa restano)
                utente.setSessionId(sessionId);
                utente.setConnesso(true);
                stanza.aggiungiLog(utente.getNome() + " si è riconnesso/a.");
            } else {
                if (stanza.getUtenti().size() >= stanza.getConfigurazione().getNumPartecipanti()) {
                    inviaEventoPrivato(stanza, sessionId, "ERRORE", "Stanza piena.");
                    return;
                }
                utente = new Utente(nome, stanza.getConfigurazione().getBudgetIniziale(), isAdmin);
                utente.setSessionId(sessionId);
                stanza.getUtenti().put(chiave, utente);
                stanza.aggiungiLog(nome + " è entrato/a nella stanza.");
            }

            sessioni.put(sessionId, new String[]{stanza.getCodice(), chiave});
            broadcastStato(stanza, null);
        } finally {
            stanza.getLock().unlock();
        }
    }

    public void disconnetti(String sessionId) {
        String[] info = sessioni.remove(sessionId);
        if (info == null) {
            return;
        }
        StanzaAsta stanza = getStanza(info[0]);
        if (stanza == null) {
            return;
        }
        stanza.getLock().lock();
        try {
            Utente utente = stanza.getUtenti().get(info[1]);
            // marca come disconnesso solo se la sessione corrente coincide (evita di disconnettere
            // un utente che si è già riconnesso da un'altra scheda/rete nel frattempo)
            if (utente != null && sessionId.equals(utente.getSessionId())) {
                utente.setConnesso(false);
                stanza.aggiungiLog(utente.getNome() + " si è disconnesso/a.");
                broadcastStato(stanza, null);
            }
        } finally {
            stanza.getLock().unlock();
        }
    }

    // ---------------------------------------------------------------- CHIAMATA

    public void chiamata(String codiceStanza, String sessionId, ChiamataRequest req) {
        StanzaAsta stanza = getStanza(codiceStanza);
        if (stanza == null) return;

        stanza.getLock().lock();
        try {
            Utente chiamante = utenteDaSessione(stanza, sessionId);
            if (chiamante == null) return;

            if (stanza.getAstaCorrente().isAttiva()) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "C'è già un giocatore all'asta.");
                return;
            }
            if (stanza.isInPausa()) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "L'asta è in pausa.");
                return;
            }
            if (req.getNomeCalciatore() == null || req.getNomeCalciatore().isBlank() || req.getRuolo() == null) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Inserisci nome e ruolo del calciatore.");
                return;
            }
            String nomeCalciatore = req.getNomeCalciatore().trim();

            String proprietarioEsistente = trovaProprietarioCalciatore(stanza, nomeCalciatore);
            if (proprietarioEsistente != null) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE",
                        nomeCalciatore + " è già stato assegnato a " + proprietarioEsistente + ".");
                return;
            }

            GiocatoreListino inListino = listinoService.trovaEsatto(nomeCalciatore);
            if (inListino != null && inListino.getRuolo() != req.getRuolo()) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE",
                        "Ruolo non corrispondente: " + inListino.getNome() + " è registrato come "
                                + etichettaRuolo(inListino.getRuolo()) + " nel listino.");
                return;
            }

            int prezzoBase = (req.getPrezzoBase() == null || req.getPrezzoBase() < 1) ? 1 : req.getPrezzoBase();

            if (chiamante.slotLiberi(req.getRuolo(), stanza.getConfigurazione()) <= 0) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Non hai più slot liberi per questo ruolo.");
                return;
            }
            if (prezzoBase > chiamante.offertaMassima(stanza.getConfigurazione())) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Budget insufficiente per aprire con questa cifra.");
                return;
            }

            String nomeSimile = trovaSimile(stanza, nomeCalciatore);
            if (nomeSimile != null) {
                inviaEventoPrivato(stanza, sessionId, "SIMILE",
                        "Attenzione: simile a \"" + nomeSimile + "\", già assegnato. Controlla di non aver sbagliato nome.");
            }

            AstaCorrente asta = stanza.getAstaCorrente();
            asta.setAttiva(true);
            asta.setCalciatoreNome(nomeCalciatore);
            asta.setRuolo(req.getRuolo());
            asta.setSquadra(inListino != null ? inListino.getSquadra() : null);
            asta.setOffertaCorrente(prezzoBase);
            asta.setOfferenteNome(chiamante.getNome());
            asta.setChiamataDaNome(chiamante.getNome());
            asta.setSecondiRimanenti(stanza.getConfigurazione().getTimerSecondi());

            stanza.aggiungiLog(chiamante.getNome() + " chiama " + asta.getCalciatoreNome()
                    + " (" + req.getRuolo() + ") base " + prezzoBase);

            avviaTimer(stanza);
            broadcastStato(stanza, null);
        } finally {
            stanza.getLock().unlock();
        }
    }

    // ---------------------------------------------------------------- RILANCIO

    public void rilancio(String codiceStanza, String sessionId, RilancioRequest req) {
        StanzaAsta stanza = getStanza(codiceStanza);
        if (stanza == null) return;

        stanza.getLock().lock();
        try {
            Utente offerente = utenteDaSessione(stanza, sessionId);
            if (offerente == null) return;

            AstaCorrente asta = stanza.getAstaCorrente();
            if (!asta.isAttiva()) {
                return;
            }
            if (stanza.isInPausa()) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "L'asta è in pausa.");
                return;
            }
            if (offerente.getNome().equalsIgnoreCase(asta.getOfferenteNome())) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Sei già tu in testa per questo giocatore!");
                return;
            }

            int importo = (req.getImporto() == null) ? asta.getOffertaCorrente() + 1 : req.getImporto();

            // qualcun altro potrebbe aver appena rilanciato: se l'importo non batte più
            // l'offerta corrente, questo client è stato semplicemente più lento.
            if (importo <= asta.getOffertaCorrente()) {
                inviaEventoPrivato(stanza, sessionId, "SEI_LENTO", "SEI LENTO!!!");
                return;
            }
            if (offerente.slotLiberi(asta.getRuolo(), stanza.getConfigurazione()) <= 0) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Non hai slot liberi per questo ruolo.");
                return;
            }
            if (importo > offerente.offertaMassima(stanza.getConfigurazione())) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Budget insufficiente per questo rilancio.");
                return;
            }

            int vecchiaOfferta = asta.getOffertaCorrente();
            asta.setOffertaCorrente(importo);
            asta.setOfferenteNome(offerente.getNome());
            asta.setSecondiRimanenti(stanza.getConfigurazione().getTimerSecondi());

            stanza.aggiungiLog(offerente.getNome() + " rilancia a " + importo);

            avviaTimer(stanza); // reset countdown
            int delta = importo - vecchiaOfferta;
            EventoDTO eventoAudio = (delta >= 5) ? new EventoDTO("AUDIO_CASH", null, "💰") : null;
            broadcastStato(stanza, eventoAudio);
        } finally {
            stanza.getLock().unlock();
        }
    }

    // ---------------------------------------------------------------- TIMER ADMIN

    public void aggiornaTimer(String codiceStanza, String sessionId, int nuoviSecondi) {
        StanzaAsta stanza = getStanza(codiceStanza);
        if (stanza == null || nuoviSecondi < 2 || nuoviSecondi > 60) return;

        stanza.getLock().lock();
        try {
            Utente utente = utenteDaSessione(stanza, sessionId);
            if (utente == null || !utente.isAdmin()) return;

            stanza.getConfigurazione().setTimerSecondi(nuoviSecondi);
            stanza.aggiungiLog("Admin ha impostato il timer a " + nuoviSecondi + "s (valido dalla prossima chiamata/rilancio).");
            broadcastStato(stanza, null);
        } finally {
            stanza.getLock().unlock();
        }
    }

    // ---------------------------------------------------------------- PAUSA (ADMIN)

    public void impostaPausa(String codiceStanza, String sessionId, boolean pausa) {
        StanzaAsta stanza = getStanza(codiceStanza);
        if (stanza == null) return;

        stanza.getLock().lock();
        try {
            Utente utente = utenteDaSessione(stanza, sessionId);
            if (utente == null || !utente.isAdmin()) return;
            if (stanza.isInPausa() == pausa) return;

            stanza.setInPausa(pausa);
            AstaCorrente asta = stanza.getAstaCorrente();

            if (pausa) {
                // congela il countdown se un giocatore è sul piatto (non lo assegna, resta lì in attesa)
                ScheduledFuture<?> t = stanza.getTimerTask();
                if (t != null) t.cancel(false);
                stanza.aggiungiLog("⏸ Admin ha messo l'asta in pausa.");
            } else {
                if (asta.isAttiva()) {
                    avviaTimer(stanza); // riprende il countdown da dove era rimasto
                }
                stanza.aggiungiLog("▶ Admin ha ripreso l'asta.");
            }

            broadcastStato(stanza, null);
        } finally {
            stanza.getLock().unlock();
        }
    }

    // ---------------------------------------------------------------- ADMIN: CORREZIONE ROSE (SOLO IN PAUSA)

    public void adminModificaRosa(String codiceStanza, String sessionId, AdminModificaRosaRequest req) {
        StanzaAsta stanza = getStanza(codiceStanza);
        if (stanza == null || req.getNomeSquadra() == null || req.getRuolo() == null) return;

        stanza.getLock().lock();
        try {
            Utente admin = utenteDaSessione(stanza, sessionId);
            if (admin == null || !admin.isAdmin()) return;
            if (!stanza.isInPausa()) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Puoi modificare le rose solo mentre l'asta è in pausa.");
                return;
            }

            Utente target = trovaUtentePerNome(stanza, req.getNomeSquadra());
            if (target == null) return;

            List<Calciatore> lista = target.getRosa().get(req.getRuolo());
            if (lista == null || req.getIndice() < 0 || req.getIndice() >= lista.size()) return;
            Calciatore calciatore = lista.get(req.getIndice());

            if (req.isRimuovi()) {
                target.setBudgetResiduo(target.getBudgetResiduo() + calciatore.getPrezzoPagato());
                lista.remove(req.getIndice());
                stanza.aggiungiLog("🛠 Admin ha rimosso " + calciatore.getNome() + " dalla rosa di " + target.getNome() + ".");
            } else {
                if (req.getNuovoPrezzo() != null && req.getNuovoPrezzo() >= 1
                        && req.getNuovoPrezzo() != calciatore.getPrezzoPagato()) {
                    int nuovoBudget = target.getBudgetResiduo() + calciatore.getPrezzoPagato() - req.getNuovoPrezzo();
                    if (nuovoBudget < 0) {
                        inviaEventoPrivato(stanza, sessionId, "ERRORE", "Prezzo troppo alto: sforerebbe il budget della squadra.");
                        return;
                    }
                    target.setBudgetResiduo(nuovoBudget);
                    calciatore.setPrezzoPagato(req.getNuovoPrezzo());
                }
                if (req.getNuovoNome() != null && !req.getNuovoNome().isBlank()) {
                    calciatore.setNome(req.getNuovoNome().trim());
                }
                stanza.aggiungiLog("🛠 Admin ha corretto la rosa di " + target.getNome() + " (" + calciatore.getNome() + ").");
            }

            broadcastStato(stanza, null);
        } finally {
            stanza.getLock().unlock();
        }
    }

    // ---------------------------------------------------------------- STUZZICA

    private static final String[] FRASI_STUZZICA = {
            "coglione",
            "figa to mare",
            "mongolo",
            "i te gà battezzà con l'acqua del codeghin",
            "non sapevo avessi la 104",
            "vai a battere in via Zoppega",
            "pelado"
    };

    public void stuzzica(String codiceStanza, String sessionId, StuzzicaRequest req) {
        StanzaAsta stanza = getStanza(codiceStanza);
        if (stanza == null || req.getNomeDestinatario() == null) return;

        stanza.getLock().lock();
        try {
            Utente mittente = utenteDaSessione(stanza, sessionId);
            if (mittente == null) return;

            AstaCorrente asta = stanza.getAstaCorrente();
            if (asta.isAttiva()) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Non puoi stuzzicare durante un'asta attiva!");
                return;
            }

            Utente destinatario = trovaUtentePerNome(stanza, req.getNomeDestinatario());
            if (destinatario == null || !destinatario.isConnesso() || destinatario.getSessionId() == null) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Utente non raggiungibile.");
                return;
            }

            if (mittente.getNome().equalsIgnoreCase(destinatario.getNome())) {
                inviaEventoPrivato(stanza, sessionId, "ERRORE", "Non puoi stuzzicare te stesso!");
                return;
            }

            String frase = FRASI_STUZZICA[RANDOM.nextInt(FRASI_STUZZICA.length)];
            String messaggio = "💬 Messaggio da " + mittente.getNome() + ": " + frase;

            inviaEventoPrivato(stanza, destinatario.getSessionId(), "STUZZICA", messaggio);
        } finally {
            stanza.getLock().unlock();
        }
    }


    // ---------------------------------------------------------------- TIMER ENGINE

    private void avviaTimer(StanzaAsta stanza) {
        // deve essere chiamato con lock già acquisito
        ScheduledFuture<?> vecchio = stanza.getTimerTask();
        if (vecchio != null) {
            vecchio.cancel(false);
        }
        ScheduledFuture<?> nuovo = scheduler.scheduleAtFixedRate(
                () -> tick(stanza), 1, 1, TimeUnit.SECONDS);
        stanza.setTimerTask(nuovo);
    }

    private void tick(StanzaAsta stanza) {
        stanza.getLock().lock();
        try {
            AstaCorrente asta = stanza.getAstaCorrente();
            if (!asta.isAttiva()) {
                ScheduledFuture<?> t = stanza.getTimerTask();
                if (t != null) t.cancel(false);
                return;
            }
            asta.setSecondiRimanenti(asta.getSecondiRimanenti() - 1);

            if (asta.getSecondiRimanenti() <= 0) {
                ScheduledFuture<?> t = stanza.getTimerTask();
                if (t != null) t.cancel(false);
                finalizzaAggiudicazione(stanza);
            } else {
                broadcastStato(stanza, null);
            }
        } finally {
            stanza.getLock().unlock();
        }
    }

    private void finalizzaAggiudicazione(StanzaAsta stanza) {
        // chiamato con lock già acquisito
        AstaCorrente asta = stanza.getAstaCorrente();
        String chiave = asta.getOfferenteNome() == null ? null : asta.getOfferenteNome().toLowerCase();
        Utente vincitore = chiave == null ? null : stanza.getUtenti().get(chiave);

        EventoDTO evento;
        if (vincitore != null) {
            vincitore.aggiudicaCalciatore(asta.getCalciatoreNome(), asta.getRuolo(), asta.getOffertaCorrente());
            stanza.aggiungiLog(vincitore.getNome() + " si aggiudica " + asta.getCalciatoreNome()
                    + " per " + asta.getOffertaCorrente() + " crediti!");
            evento = new EventoDTO("AGGIUDICAZIONE", null,
                    vincitore.getNome() + " si aggiudica " + asta.getCalciatoreNome() + " per " + asta.getOffertaCorrente() + "!");
        } else {
            evento = null;
        }

        asta.reset();
        broadcastStato(stanza, evento);
    }

    // ---------------------------------------------------------------- BACKUP AUTOMATICO

    private void eseguiBackupPeriodico() {
        for (StanzaAsta stanza : stanze.values()) {
            stanza.getLock().lock();
            try {
                Utente admin = trovaUtentePerNome(stanza, stanza.getAdminNome());
                if (admin == null || !admin.isConnesso() || admin.getSessionId() == null) {
                    continue; // admin non connesso ora: niente da fare, riproveremo tra 60s
                }

                BackupStanzaDTO backup = new BackupStanzaDTO();
                backup.setCodiceOriginale(stanza.getCodice());
                backup.setTimestampMillis(System.currentTimeMillis());
                backup.setConfigurazione(stanza.getConfigurazione());
                backup.setAdminNome(stanza.getAdminNome());
                backup.setLog(new ArrayList<>(stanza.getLog()));

                List<UtenteDTO> utenti = new ArrayList<>();
                for (Utente u : stanza.getUtenti().values()) {
                    utenti.add(UtenteDTO.from(u, true));
                }
                backup.setUtenti(utenti);

                messagingTemplate.convertAndSendToUser(admin.getSessionId(), "/queue/backup", backup);
            } catch (Exception e) {
                System.out.println("[StanzaService] Backup periodico fallito per stanza " + stanza.getCodice() + ": " + e.getMessage());
            } finally {
                stanza.getLock().unlock();
            }
        }
    }

    // ---------------------------------------------------------------- HELPERS

    private Utente utenteDaSessione(StanzaAsta stanza, String sessionId) {
        String[] info = sessioni.get(sessionId);
        if (info == null || !info[0].equals(stanza.getCodice())) return null;
        return stanza.getUtenti().get(info[1]);
    }

    private Utente trovaUtentePerNome(StanzaAsta stanza, String nome) {
        if (nome == null) return null;
        return stanza.getUtenti().get(nome.trim().toLowerCase());
    }

    /** Ritorna il nome della squadra proprietaria se il calciatore è già stato assegnato (match esatto, case-insensitive). */
    private String trovaProprietarioCalciatore(StanzaAsta stanza, String nomeCalciatore) {
        for (Utente u : stanza.getUtenti().values()) {
            for (List<Calciatore> lista : u.getRosa().values()) {
                for (Calciatore c : lista) {
                    if (c.getNome().equalsIgnoreCase(nomeCalciatore)) {
                        return u.getNome();
                    }
                }
            }
        }
        return null;
    }

    /** Ritorna il nome di un calciatore già assegnato con le stesse 4 iniziali (possibile typo), o null se nessuna somiglianza. */
    private String trovaSimile(StanzaAsta stanza, String nomeCalciatore) {
        String chiave = primeIniziali(nomeCalciatore);
        if (chiave.isEmpty()) return null;

        for (Utente u : stanza.getUtenti().values()) {
            for (List<Calciatore> lista : u.getRosa().values()) {
                for (Calciatore c : lista) {
                    if (c.getNome().equalsIgnoreCase(nomeCalciatore)) continue; // match esatto, già gestito altrove
                    if (primeIniziali(c.getNome()).equals(chiave)) {
                        return c.getNome();
                    }
                }
            }
        }
        return null;
    }

    private String primeIniziali(String nome) {
        String pulito = nome.trim().toLowerCase();
        return pulito.substring(0, Math.min(4, pulito.length()));
    }

    private String etichettaRuolo(Ruolo ruolo) {
        return switch (ruolo) {
            case PORTIERE -> "Portiere";
            case DIFENSORE -> "Difensore";
            case CENTROCAMPISTA -> "Centrocampista";
            case ATTACCANTE -> "Attaccante";
        };
    }

    private void inviaEventoPrivato(StanzaAsta stanza, String sessionId, String tipo, String messaggio) {
        String[] info = sessioni.get(sessionId);
        String nomeTarget = info == null ? null : stanza.getUtenti().containsKey(info[1])
                ? stanza.getUtenti().get(info[1]).getNome() : null;
        broadcastStato(stanza, new EventoDTO(tipo, nomeTarget, messaggio));
    }

    private void broadcastStato(StanzaAsta stanza, EventoDTO evento) {
        for (Utente destinatario : stanza.getUtenti().values()) {
            if (!destinatario.isConnesso() || destinatario.getSessionId() == null) {
                continue; // non raggiungibile ora; riceverà lo stato aggiornato al reconnect/join
            }

            StatoStanzaDTO dto = new StatoStanzaDTO();
            dto.setCodiceStanza(stanza.getCodice());
            dto.setConfigurazione(stanza.getConfigurazione());
            dto.setAdminNome(stanza.getAdminNome());
            dto.setAstaCorrente(stanza.getAstaCorrente());
            dto.setLog(new ArrayList<>(stanza.getLog()));
            dto.setInPausa(stanza.isInPausa());
            dto.setPartecipanti(costruisciListaPartecipanti(stanza, destinatario));

            // un evento con targetNome valorizzato va recapitato solo a quel destinatario
            boolean eventoPerQuestoUtente = evento != null
                    && (evento.getTargetNome() == null || evento.getTargetNome().equalsIgnoreCase(destinatario.getNome()));
            dto.setEvento(eventoPerQuestoUtente ? evento : null);

            messagingTemplate.convertAndSendToUser(destinatario.getSessionId(), "/queue/stato", dto);
        }
    }

    /**
     * Costruisce la lista partecipanti da mostrare a un preciso destinatario: budget residuo e
     * rosa sono visibili solo per la propria fantasquadra e, per l'admin, per tutte quante —
     * mai per gli altri partecipanti "normali", per non dare vantaggio nei rilanci a fine asta.
     */
    private List<UtenteDTO> costruisciListaPartecipanti(StanzaAsta stanza, Utente destinatario) {
        List<UtenteDTO> lista = new ArrayList<>();
        for (Utente u : stanza.getUtenti().values()) {
            boolean self = u.getNome().equalsIgnoreCase(destinatario.getNome());
            boolean mostraDettagli = destinatario.isAdmin() || self;
            lista.add(UtenteDTO.from(u, mostraDettagli));
        }
        return lista;
    }
}
