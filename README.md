# AI-chat-helper

AI-chat-helper is an AI module that communicates with clients for a CRM. It answers clients in Instagram and in the Jivo website live chat. It creates, tracks and cancels orders through the CRM API and webhooks. When necessary, it sends a WhatsApp notification to a human operator. The operator then answers the client in the operator chat.

The module operates with all CRMs. Each CRM connects through an adapter. The module operates with all types of business. The catalog ("menu") can contain all types of goods or services.

This document is for developers and DevOps engineers.

---

## Functions

- **Channels**: Instagram Direct (Meta Instagram API with Instagram Login) and the Jivo website live chat (Jivo Bot API).
- **Tidio is not supported**: the public Tidio API has no webhook for a visitor message in live chat and no endpoint for a bot reply. Only tickets have a reply endpoint. Refer to *Open items*.
- **Order operations**: The module creates, tracks and cancels orders through a CRM adapter. The CRM gives a payment link for each new order. The bot shows the link to the client. The CRM sends order status changes to the module through a webhook. The bot tells the client about each change.
- **AI behavior that you can configure**: harness prompts, tone of voice, topic restriction level, catalog data source and reply delays that look human. You set all of these in the admin panel.
- **Human handoff**: The module sends a WhatsApp notification to an operator from the operator pool. The notification contains a link to the operator chat. The operator talks to the client in the operator chat. When the operator sends `/out-to-AI`, the AI continues the conversation.
- **Agent memory**: The module keeps the dialogs in Postgres with pgvector. This includes the handoff transcripts. The module uses pgvector for semantic search of the past dialogs.
- **Languages**: English and French. You can add more languages as language packs.
- **Examples from a dataset**: The module learns tone of voice and new languages from example dialogs. During operation, it gets the applicable examples from a dataset. It uses them as few-shot examples. The module does not fine-tune the model. Thus it operates with all model providers.

---

## Applications

| Application | Purpose | Users |
|---|---|---|
| **Backend** | Channels, AI agent, CRM adapter, workers, APIs | — |
| **Worker** | Background jobs: agent turns, delayed replies, CRM status events, handoff time limits, order status check | — |
| **Admin panel** | Setup only. All configuration parameters. | CRM administrators |
| **Operator chat** | Live chat with clients during a handoff. Conversation history and handoff log. | Operators, urgent managers |

The admin panel and the operator chat are two separate React single-page applications (SPAs). Admins and operators log in through the CRM (OAuth).

---

## Tech stack

| Layer | Selection |
|---|---|
| Backend language | Python 3.12+ |
| Backend framework | FastAPI |
| Database | PostgreSQL 16+ with `pgvector` |
| LLM | An interface that operates with all providers. Start model: Claude Sonnet 5.5. Refer to `DESCRIPTION.md` → *Model selection*. |
| Admin panel | React SPA (TypeScript). It uses the admin API. |
| Operator chat | React SPA (TypeScript). It uses the operator API and a WebSocket. |
| Authentication | CRM OAuth, for the CRM API and for the user login |
| Notifications | WhatsApp Business Cloud API (only for notifications) |
| Urgent calls | Twilio (text-to-speech), behind a `TelephonyClient` interface |
| Packages and run | Docker, docker compose |

---

## Configuration (admin panel)

The module keeps all parameters in Postgres. It keeps a version of each change. You can change the parameters in the admin panel. Each CRM tenant (module instance) has its own configuration.

### 1. Harness prompts

The harness prompts are a set of prompt templates. Each prompt has an English version and a French version. Each language pack adds one more version.

| Prompt | Purpose |
|---|---|
| `system` | The main role, the rules and the tool-use policy |
| `greeting` | The first reply in a new conversation |
| `fallback` | The reply when the bot does not understand the request, or cannot do it |
| `escalation` | The text for the handoff to a human |
| `order_confirmation` | It gives a summary of the order. It asks the client to confirm before the module creates or cancels the order. |
| `sales_funnel.<stage>` | The instructions for each stage of the sales funnel. You can change the stages. Default stages: greeting → needs discovery → offer → order → payment → status change notifications → feedback collection. |

### 2. Catalog ("menu") data source

| Source | Notes |
|---|---|
| CRM product catalog | The module reads it through the CRM adapter. |
| External API | Set the URL, the authentication and the field mapping in the admin panel. |

The module gets the catalog at set intervals. It keeps a copy in Postgres, with embeddings for semantic product search.

### 3. Tone of voice

- **Presets**: `formal`, `friendly`, `playful`. You can add more presets.
- **Dataset**: Load a dataset of example dialogs. During operation, the module gets the most applicable examples from pgvector. It adds them to the prompt as few-shot examples.

### 4. Topic restriction level

| Level | Behavior |
|---|---|
| `medium` | The bot can talk about other topics for a short time. The bot moves the conversation back to the subject in a maximum of 3 messages. |
| `high` | The bot refuses all other topics in a short reply. |
| `strict` | The bot answers only about products and orders. |

### 5. Delays that look human

```
delay = random(min_delay, max_delay) + per_char_delay * len(reply)
delay = min(delay, max_total_delay)
```

| Parameter | Description | Default |
|---|---|---|
| `min_delay`, `max_delay` | The range for the random base delay, in seconds | 2 s, 10 s |
| `per_char_delay` | The seconds that the module adds for each character of the reply | 0.03 s |
| `max_total_delay` | The maximum total delay | 30 s |

If the channel API has a "typing…" indicator, the module shows it for the full delay.

### 6. Languages

- The module has English and French.
- To add a language, add a **language pack**. A language pack contains translated harness prompts and a dataset of example dialogs in that language.

### 7. Operator pool

- Add the operators in the admin panel. Each operator is a CRM user with a WhatsApp phone number.
- Set one or more **urgent managers**. An urgent manager is a CRM user. The module sends an urgent alert to the urgent managers when no operator accepts a handoff. For each urgent manager, set these items:
  - The phone number.
  - The communication type: `phone_call`, `whatsapp_text`, or the two.

---

## Orders and payment

1. The client selects products. The bot uses the `order_confirmation` prompt. The client confirms.
2. The module calls `create_order()`. The CRM creates the order and gives a payment link.
3. The bot shows the payment link to the client.
4. The client pays. The CRM sends an order status change to the module through a webhook.
5. The bot tells the client about the new status.

The bot also tells the client about all other order status changes. Before the module cancels an order, the client must confirm.

A finished order has one of these statuses: `completed`, `cancelled`, `refunded`. All other orders are unfinished.

### Status changes: special cases

- **During a handoff**: The bot does not send the status message to the client. The operator chat shows the status change to the operator.
- **Closed channel window**: Sometimes the channel cannot deliver a message. For example, the Instagram 24-hour window is closed, or the website visitor is offline.
  - Unfinished order: The module keeps the conversation and the status message for a minimum of 30 days. When the client writes again, the module sends the status message and continues the conversation.
  - Finished order: The module keeps the conversation with a reference to the client ID.
- **Lost webhooks**: A worker gets the status of each unfinished order from the CRM at set intervals (`get_order_status`, default: 10 minutes). If the status changed, the module does the same steps as for a webhook.

---

## Human handoff

### Triggers

Each of these conditions starts a handoff:

1. The client asks for a human **two times** in one conversation.
2. The client asks for a human **with harsh words**. The module finds harsh words with a keyword list that you can configure. An AI sentiment check also finds them.
3. The **confidence of the AI is less than** the limit that you set (default: 0.6).

### Procedure

1. The AI sends the `escalation` message to the client. Then the AI stops.
2. The module selects an operator from the operator pool. If the operator does not accept in 1 minute (default), the module writes an alert to the log. Then it selects the next operator. If no operator in the pool accepts, the module sends an urgent alert to the urgent managers. At the same time, the AI continues the conversation with the client.
3. The module sends a WhatsApp notification to the operator. The notification contains a link to the conversation in the operator chat.
4. The operator opens the link and logs in through the CRM. The operator chat shows the conversation summary and the full history.
5. The operator and the client talk. The operator chat sends the messages to the client channel. The client messages come to the operator chat in real time (WebSocket).
6. The operator sends `/out-to-AI`. The AI continues the conversation.
7. The module keeps the full dialog in the agent memory. This includes the handoff part.

### WhatsApp notifications

- The module uses WhatsApp only to send notifications. The dialog does not go through WhatsApp.
- Each notification is a message that the business starts. Thus each notification must use an approved **utility template**. Meta charges for each template message.
- **Development**: Use the `WhatsAppClient` mock. For real tests, make a Meta developer account and a Meta app with the WhatsApp product. Meta gives a free test phone number and a temporary token. You can send messages to a maximum of 5 verified phone numbers. Business verification is not necessary for this.
- **Production**: These items are necessary: business verification, a real phone number with an approved display name, a payment method, a permanent system-user token and an approved utility template.

### Urgent alerts to managers

The module uses the communication type and the phone number of each urgent manager from the admin panel.

| Communication type | Procedure |
|---|---|
| `phone_call` | The module makes a usual phone call through Twilio. Twilio reads this text to the manager (text-to-speech): "Hello. You have unhandled order conversations. Please check in whatsapp chat". Call permission and a media component are not necessary. |
| `whatsapp_text` | The module sends a WhatsApp template message from the business phone number. The message contains a link to the conversation in the operator chat. |

The telephony service is behind a `TelephonyClient` interface. Thus you can replace the provider.

---

## Operator chat

- Live chat with the client during a handoff, with the `/out-to-AI` command.
- **Conversation history**: The past conversations of the tenant, with the order data.
- **Handoff log**: All handoffs, with the trigger, the operator, the accept time and the alerts.

---

## Data retention

- The module keeps the conversations, the agent memory and the client data for a **maximum of 3 years**. A daily job deletes older data.
- If a client asks to delete their data or their account, the module deletes all data of that client. This includes the messages, the memory items and the embeddings. An admin starts the deletion in the admin panel.
- For unfinished orders, the module keeps the conversation for a minimum of 30 days. Refer to *Status changes: special cases*.

---

## CRM integration

The module connects to the CRM through an adapter interface. This interface operates with all CRMs. The module uses OAuth for the CRM API.

| Operation | Direction |
|---|---|
| `get_catalog()` | module → CRM API |
| `create_order()` → order ID and payment link | module → CRM API |
| `get_order_status()` | module → CRM API |
| `cancel_order()` | module → CRM API |
| Order status change events (payment included) | CRM → module webhook |
| User login (admins and operators) | CRM OAuth |

---

## HTTP endpoints (planned)

| Path | Purpose |
|---|---|
| `POST /webhooks/crm/{tenant}` | Incoming CRM order status events |
| `POST /webhooks/jivo/{tenant}/{token}` | Incoming Jivo Bot API events. The token in the path is the Jivo channel token. |
| `POST /webhooks/tidio/{tenant}` | Returns 501: Tidio is not supported |
| `GET/POST /webhooks/instagram/{tenant}` | Meta webhook verification and incoming Instagram messages |
| `GET/POST /webhooks/whatsapp` | WhatsApp Cloud API verification and delivery status of notifications |
| `/auth/*` | CRM OAuth login for admins and operators |
| `/admin/api/*` | Admin panel API |
| `/operator/api/*` | Operator chat API |
| `/operator/ws` | Operator chat WebSocket |
| `GET /healthz`, `GET /readyz` | Liveness and readiness probes |

For all incoming webhooks, do a check of the signature or the shared secret. Do this if the provider supplies one.

---

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres DSN (`postgresql+asyncpg://…`) |
| `LLM_PROVIDER`, `LLM_API_KEY` | The LLM provider and the key |
| `LLM_MODEL_MAIN` | The model for the conversation and the tool calls |
| `LLM_MODEL_FAST` | The model for the classifiers (intent, sentiment, confidence, language) |
| `EMBEDDING_MODEL` | The embedding model for pgvector |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_TEMPLATE_NAME` | WhatsApp Cloud API |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN` | Meta Instagram API |
| `JIVO_*`, `TIDIO_*` | Live chat credentials |
| `TELEPHONY_PROVIDER`, `TELEPHONY_API_KEY`, `TELEPHONY_FROM_NUMBER` | Telephony service for urgent calls |
| `OPERATOR_CHAT_URL` | The base URL of the operator chat. The module uses it for the links in the notifications. |
| `PUBLIC_BASE_URL` | The public URL of the backend. The OAuth callback uses it. |
| `SESSION_SECRET_KEY` | The key that signs the user sessions |
| `ENCRYPTION_KEY` | The Fernet key that encrypts the credentials in the database |
| `WHATSAPP_URGENT_TEMPLATE_NAME` | The WhatsApp template for urgent alerts to managers |
| `TELEPHONY_ACCOUNT_SID` | Twilio account SID (`TELEPHONY_API_KEY` is the auth token) |
| `JIVO_API_BASE`, `INSTAGRAM_API_BASE`, `WHATSAPP_API_BASE`, `TELEPHONY_API_BASE` | API base URLs. Local docker points them to the mock servers. |
| `FRONTEND_ORIGINS` | SPA origins that the login can redirect to |
| `CRM_AUTHORIZE_BASE_OVERRIDE` | Local docker only: the browser URL of the mock CRM |
| `LOG_LEVEL` | The log level |

Keep the secrets in a secret manager or in `.env`. Do not commit `.env`. The module encrypts the CRM OAuth credentials of each tenant and keeps them in the database.

---

## Local start

Necessary tools: Python 3.12+, Docker, GNU make, Node.js.

```bash
cp .env.example .env          # fill in the values
make install                  # .venv with pip, and npm install for the two SPAs
docker compose up -d db       # Postgres with pgvector (also makes the chat_test database)
make migrate                  # Alembic migrations
make lint                     # ruff, mypy, eslint, tsc
make test                     # pytest (integration tests use the db service), vitest
make dev                      # full stack: db, backend, worker, mocks, two SPAs
make seed-dev                 # dev tenant: mock CRM, Jivo channel, 2 operators, 1 urgent manager
```

`make seed-dev` prints the tenant ID. Open the SPAs with `?tenant=<tenant ID>`. The mock CRM shows a page where you select the user: `admin-1` (admin), `operator-1` or `operator-2` (operators), `manager-1` (urgent manager).

Create a real tenant with `python -m app.cli create-tenant --name ... --crm-base-url ... --client-id ... --client-secret ... --webhook-secret ...`. After you change an API, run `make api-types`.

| Item | URL |
|---|---|
| Backend API documentation | `http://localhost:8000/docs` |
| Admin panel (dev server) | `http://localhost:5173/admin/` |
| Operator chat (dev server) | `http://localhost:5174/operator/` |
| Mock servers | `http://localhost:8090/docs` |

For local development, mock services replace the CRM (OAuth included), Jivo, Instagram, WhatsApp and Twilio. The AI model is a mock until build step 11, so the bot does not answer real messages in the local stack yet. The mock CRM uses the generic contract in `app/adapters/crm/generic_http.py`. Refer to `DESCRIPTION.md` → *Development harness*.

---

## Deployment

- The backend is a stateless container. You can add more containers to increase the capacity. Postgres keeps all the state.
- The two SPAs are static files. Serve them from a CDN, a web server or the backend.
- The operator WebSocket must operate with more than one backend container. Use Postgres `LISTEN/NOTIFY` to send events between the containers.
- Background jobs do the delayed replies and the typing indicator. The request handlers do not do this work. Thus the webhooks return quickly.
- Postgres must have the `vector` extension. Before each rollout, run the migrations with Alembic.
- The logs are in JSON format. Measure these items for each conversation: response latency, LLM tokens and cost, handoff rate, and the number of correct and failed orders.
- Make backups of Postgres. It keeps the conversations, the agent memory and the configuration.

---

## Open items (TBD)

- The final AI model. Start with Claude Sonnet 5.5. Confirm the selection with the eval suite after all other parts are complete.
- The prices (Meta, Jivo, LLM). Not examined at this time.
- **Tidio**: its API cannot run a live-chat bot. Select one: remove Tidio, connect Tidio through another way (for example its own bot flows), or wait for an API change.
- The real AI model and embedding providers (build step 11).
