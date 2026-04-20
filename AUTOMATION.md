# Koronet Hubs — Automatización de sync

Dos GitHub Actions sincronizan los hubs automáticamente:

| Action | Fuente | Qué hace | Frecuencia |
|--------|--------|----------|-----------|
| `sync-pmt.yml` | Salesforce (`inov8__PMT_Project__c`) | Escribe `data/{slug}/pmt.json` con phases %, target go-live, team | Cada 3 horas |
| `sync-fathom.yml` | Fathom API | Escribe `data/{slug}/status.json` (42 topics) + `data/{slug}/recordings.json` | Cada 2 horas |

Ambos también se ejecutan al hacer `workflow_dispatch` (manual) o cuando cambias `config/` o los scripts.

## Setup (una sola vez)

### 1. Agregar secrets en GitHub

Settings → Secrets and variables → Actions → New repository secret.

**Salesforce (6 secrets):**
- `SF_LOGIN_URL` — `https://login.salesforce.com` (o sandbox URL si aplica)
- `SF_CLIENT_ID` — Consumer Key de la Connected App "Koronet Hub"
- `SF_CLIENT_SECRET` — Consumer Secret
- `SF_USERNAME` — el usuario de Salesforce que corre las queries
- `SF_PASSWORD` — password de ese usuario
- `SF_SECURITY_TOKEN` — security token (Setup → My Personal Information → Reset Security Token)

**Fathom (1 secret):**
- `FATHOM_API_KEY`

### 2. Permitir push desde Actions

Settings → Actions → General → Workflow permissions → marcar "Read and write permissions".

### 3. Correr la primera vez manual

Actions → "Sync PMT from Salesforce" → Run workflow → branch `main` → Run.
Después lo mismo con "Sync Fathom transcripts and statuses".

Si todo va bien, veras commits nuevos del bot en `/data/` con los JSONs.

## Agregar un hub nuevo

Edita `config/hubs.json`, agrega una entrada:

```json
{
  "slug": "cliente-x",
  "name": "Cliente X LLC",
  "pmt_id": "a9PVL000000ABC123",
  "fathom_client_filter": "Cliente X",
  "hub_file": "cliente-x-client.html"
}
```

El push dispara las Actions y automáticamente genera `data/cliente-x/`.

## Criterios de matching Fathom → training topics

Regla determinista (NO uses LLM) en `scripts/sync-fathom.mjs`:
- 0 keyword hits → `not_started`
- 1 hit → `partial`
- 2+ hits → `done`

Los keywords viven en `config/training-topics.json`. Si un topic queda mal clasificado, ajustar keywords ahí. Es rule-based, NO interpretación.

## Datos que genera

### `data/{slug}/pmt.json`
```json
{
  "fetched_at": "2026-04-20T20:00:00Z",
  "id": "a9PVL000000Jjkb2AC",
  "name": "Lartisan Roses LLC",
  "phases": [
    {"key": "sales_handover", "label": "Sales Handover", "pct": 62},
    ...
  ],
  "targets": {"go_live_date": "2026-04-28", "status": "In Progress"},
  "team": {"implementer": "Manuel Szajowicz", "sales_rep": "Felipe Mesa"},
  "raw": { /* full SF record for debugging */ }
}
```

### `data/{slug}/status.json`
```json
{
  "updated_at": "2026-04-20T20:00:00Z",
  "statuses": [
    {"id": 1, "text": "Komet general tour", "status": "done", "hits": 3},
    ...
  ]
}
```

### `data/{slug}/recordings.json`
```json
{
  "updated_at": "2026-04-20T20:00:00Z",
  "recordings": [
    {"id": "642104858", "title": "L'artisan Implementation", "date": "2026-04-20T...", "url": "https://fathom.video/calls/642104858", "duration_minutes": 56, "host": "Manuel Szajowicz"}
  ]
}
```

## Nota sobre campos de PMT

`scripts/sync-pmt.mjs` asume estos nombres de campos custom en `inov8__PMT_Project__c`:
- `inov8__Sales_Handover_Progress__c`
- `inov8__Account_Configuration_Progress__c`
- `inov8__Kickoff_Progress__c`
- `inov8__Training_Progress__c`
- `inov8__Pre_Go_Live_Progress__c`
- `inov8__Post_Go_Live_Progress__c`
- `inov8__Target_Go_Live_Date__c`
- `inov8__Status__c`
- `inov8__Implementer__c` / `inov8__Implementation_Consultant__c`
- `inov8__Sales_Rep__c`

Si alguno no existe o tiene otro nombre en la org de Koronet, los campos correspondientes quedan `null` (no rompe nada). La primera corrida del Action te va a mostrar el `raw` completo del record — con eso ajustamos los nombres si hace falta.
