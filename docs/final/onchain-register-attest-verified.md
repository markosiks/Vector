# ✅ ПОДТВЕРЖДЁННЫЙ ЭТАП: on-chain workflow `register → attest` (Mantle Sepolia)

> **Статус: ЗАВЕРШЕНО И ПРОВЕРЕНО ВЖИВУЮ.** Полный цикл «регистрация агента →
> аттестация (`giveFeedback`)» прогнан на Mantle Sepolia с двумя боевыми
> ключами и подтверждён чтением состояния из контрактов. **Повторно прогонять
> этот сценарий для проверки не требуется** — не дублируем работу.
>
> Дата фиксации: 2026-06-10.

---

## 1. Что именно проверено

Сквозной рабочий процесс ERC-8004 в двухключевой модели:

1. `registerAgent` (кошелёк **operator**, он же `msg.sender` → owner агента) —
   минт ERC-721 tokenId в canonical Identity Registry, `agentId` декодирован из
   события `Registered`.
2. `assertCanAttest` — предпроверка на self-feedback (attestor ≠ owner).
3. `giveFeedback` (кошелёк **attestor**) — запись AgentScore + `feedbackHash`
   (анкор off-chain detail) в canonical Reputation Registry.

Раннер: [`scripts/chain/register-and-attest.ts`](../../scripts/chain/register-and-attest.ts)
(production-caller, тонкая композиция уже покрытого тестами chain-слоя; PR #45).

## 2. Сеть и контракты

| | |
|---|---|
| Сеть | **Mantle Sepolia Testnet** |
| chainId | **5003** |
| RPC | `https://rpc.sepolia.mantle.xyz` |
| Explorer | `https://explorer.sepolia.mantle.xyz` |
| Identity Registry (canonical ERC-8004) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation Registry (canonical ERC-8004) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

## 3. Ключи (две РАЗНЫЕ EOA — обязательное условие)

Реестр запрещает self-feedback, поэтому operator и attestor — разные адреса.

| Роль | Адрес | Назначение |
|---|---|---|
| **OPERATOR** | `0x1eB8FF35d7d66CE31EB11FdeC966756279EC0F75` | `registerAgent` (владелец агента) |
| **ATTESTOR** | `0xAdf0997bEEB5d6C8A6A2E9C31a8A5A4638C90858` | `giveFeedback` (автор отзыва) |

Оба адреса профинансированы тестовым MNT (по 50 MNT) из фаукета Mantle Sepolia.

> 🔐 **Приватные ключи в этот документ намеренно НЕ включены.** Репозиторий
> публичный (open-source условие хакатона), а коммит секрета в git-историю —
> необратимая утечка. Это throwaway testnet-ключи, но принцип соблюдаем строго:
> приватные ключи хранятся вне репозитория и задаются только через `.env.local`
> / переменные окружения при запуске. В git/README/доки попадают **только
> публичные адреса**.

## 4. Результат прогона (живые транзакции)

- **Регистрация:** `agentId` (tokenId) = **136**; `ownerOf(136)` = OPERATOR.
- **Аттестация:** `giveFeedback` — статус **success**.
  - tx: `0x99101710c82bfc64fd37cb838c4c9426402cc91ebbdf6931b17aca36841874e9`
  - explorer: `https://explorer.sepolia.mantle.xyz/tx/0x99101710c82bfc64fd37cb838c4c9426402cc91ebbdf6931b17aca36841874e9`

## 5. Подтверждение чтением из контрактов (read-back)

```
ownerOf(136)                         = 0x1eB8FF35d7d66CE31EB11FdeC966756279EC0F75  (operator)
getClients(136)                      = [ 0xAdf0997bEEB5d6C8A6A2E9C31a8A5A4638C90858 ]  (attestor)
getLastIndex(136, attestor)          = 1
getSummary(136, [attestor], v/ascore) = count=1, value=73500, valueDecimals=3   → AgentScore 73.500
readFeedback(136, attestor, 1)       = value=73500, dec=3, tag1="vector", tag2="agentscore", isRevoked=false
feedbackHash                         = 0xb35ac4ab25bf07feca73bc1433268d72ec2140a4e1516ab920c9b8d77f228abd
```

Запись реально существует и читается из реестра — это и есть «substantive use of
Mantle» + AI-функция, вызываемая on-chain.

## 6. Как воспроизвести (если понадобится)

```bash
# ключи и RPC — из .env.local / окружения (НЕ из репозитория)
DATABASE_URL='postgresql://placeholder/db' \   # только формат-валидация env, без DB I/O
MANTLE_TESTNET_RPC_URL='https://rpc.sepolia.mantle.xyz' \
PUBLIC_BASE_URL='https://<deploy-url>' \
OPERATOR_PRIVATE_KEY=0x... ATTESTOR_PRIVATE_KEY=0x... \
REUSE_AGENT_ID=136 \                            # переиспользовать минт, не плодить токены
bun --conditions=react-server scripts/chain/register-and-attest.ts
```

Примечания по запуску (зафиксированы, чтобы не наступать снова):
- Скрипты, импортирующие `server-only`-модули, под bun требуют
  `--conditions=react-server`.
- Canonical-реестр имеет read-after-write лаг на public RPC (свежеминченный
  tokenId кратко читается как nonexistent) — раннер поллит `ownerOf` перед
  предпроверкой (`waitForAgentRegistered`).
- `DATABASE_URL` нужен только для формат-валидации env-схемы; раннер не делает
  DB I/O.

## 7. Открытый риск (НЕ закрыт этим этапом)

Записи сделаны в **canonical** ERC-8004 реестры, а не в собственный
развёрнутый контракт. Для общего требования «deployed on Mantle» и особенно для
**20 Project Deployment Award** («Smart contract deployed… verified on Mantle
Explorer… deployment address») надёжнее задеплоить тонкий собственный
Vector-контракт на Mantle Sepolia и верифицировать его. Это отдельная задача
(см. план дальше), данный этап её не покрывает.
