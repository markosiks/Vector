# VectorMeritRegistry — Развёрнутый смарт-контракт

## Назначение

`VectorMeritRegistry` — ончейн-якорь проекта **Vector** для AI-аттестации заслуг (merit) автономных агентов на сети Mantle. Контракт реализует:

- **AI-вызываемую функцию** `attestScore`: авторизованный аттестатор (off-chain AI) публикует оценку агента (AgentScore 0..100.0 с одним десятичным, хранится как 0..1000).
- **Чтение для роутера/файрвола**: `latestScore` и `isEligible` — гейт допуска к капиталу на основе репутации.
- **Ротацию аттестатора**: владелец контракта может заменить адрес аттестатора через `setAttestor`.

Контракт минимален и не содержит прокси, апгрейдов или избыточной логики. Используется OpenZeppelin `Ownable` для контроля доступа.

---

## Сеть и адреса

| Параметр | Значение |
|---|---|
| **Сеть** | Mantle Sepolia (testnet) |
| **Chain ID** | `5003` |
| **RPC** | `https://rpc.sepolia.mantle.xyz` |
| **Адрес контракта** | `0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12` |
| **Explorer (верифицирован)** | [sepolia.mantlescan.xyz/address/0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12](https://sepolia.mantlescan.xyz/address/0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12) |
| **Sourcify (exact match)** | [sourcify.dev](https://sourcify.dev/#/lookup/0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12) |
| **Владелец (operator)** | `0x1eB8FF35d7d66CE31EB11FdeC966756279EC0F75` |
| **Аттестатор** | `0xAdf0997bEEB5d6C8A6A2E9C31a8A5A4638C90858` |

---

## Аргументы конструктора

```solidity
constructor(address initialOwner, address initialAttestor)
```

- `initialOwner`: `0x1eB8FF35d7d66CE31EB11FdeC966756279EC0F75`
- `initialAttestor`: `0xAdf0997bEEB5d6C8A6A2E9C31a8A5A4638C90858`

ABI-кодированные аргументы:
```
0x0000000000000000000000001eb8ff35d7d66ce31eb11fdec966756279ec0f75
  000000000000000000000000adf0997beeb5d6c8a6a2e9c31a8a5a4638c90858
```

---

## AI-функция: attestScore

Это **основная ончейн AI-функция** контракта. Off-chain AI-сервис вычисляет оценку агента и публикует её через аттестатора.

### Сигнатура

```solidity
function attestScore(uint256 agentId, uint16 score, bytes32 evidenceHash) external
```

### ABI

```json
{
  "type": "function",
  "name": "attestScore",
  "inputs": [
    {"name": "agentId", "type": "uint256"},
    {"name": "score", "type": "uint16"},
    {"name": "evidenceHash", "type": "bytes32"}
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
}
```

### Параметры

- `agentId` — уникальный идентификатор агента (uint256).
- `score` — оценка 0..1000 (= 0.0..100.0 с одним десятичным знаком). Значения > 1000 приводят к revert.
- `evidenceHash` — keccak256-хеш off-chain пакета доказательств.

### Инварианты

- Только авторизованный аттестатор может вызвать функцию.
- Оценка ∈ [0, 1000]; значения вне диапазона → revert `ScoreOutOfRange`.
- Нонс строго возрастает для каждого agentId.
- `isEligible` == (нонс > 0 AND последняя оценка >= minScore).
- Для неизвестного agentId: `exists = false`, `isEligible = false`.

---

## Функции чтения

```solidity
function latestScore(uint256 agentId) external view
    returns (uint16 score, bytes32 evidenceHash, uint64 timestamp, uint64 nonce, bool exists);

function isEligible(uint256 agentId, uint16 minScore) external view returns (bool);
```

---

## Живая транзакция attestScore

| Параметр | Значение |
|---|---|
| **TX Hash** | `0x5b340207639633cd3a07660d37e0744eb9002e31a674177e1aef28814c7de090` |
| **agentId** | `136` |
| **score** | `735` (= 73.5) |
| **evidenceHash** | `0x12e9452152e265a35eb2b7c974e9c747bc1f00c23da073ab9026fcf2b260abf8` |
| **Статус** | ✅ Success (status=1) |
| **Explorer** | [TX на Mantlescan](https://sepolia.mantlescan.xyz/tx/0x5b340207639633cd3a07660d37e0744eb9002e31a674177e1aef28814c7de090) |

### Ончейн read-back

```
latestScore(136):
  score         = 735
  evidenceHash  = 0x12e9452152e265a35eb2b7c974e9c747bc1f00c23da073ab9026fcf2b260abf8
  timestamp     = 1781075771
  nonce         = 1
  exists        = true

isEligible(136, 700) = true   (735 >= 700 ✅)
isEligible(136, 800) = false  (735 < 800 ❌)
```

---

## Воспроизведение (без секретов)

### Требования

- [Foundry](https://getfoundry.sh/) (forge, cast)
- Приватные ключи в переменных окружения (НЕ в репозитории)

### Сборка и тесты

```bash
cd contracts/
forge build
forge test -vvv
```

### Деплой

```bash
# Загрузите ключи из БЕЗОПАСНОГО хранилища (не из репозитория!)
# Переменные: OPERATOR_PRIVATE_KEY, ATTESTOR_PRIVATE_KEY
set -a; . /path/to/secure/vector_keys.env; set +a

export OWNER_ADDRESS=0x1eB8FF35d7d66CE31EB11FdeC966756279EC0F75
export ATTESTOR_ADDRESS=0xAdf0997bEEB5d6C8A6A2E9C31a8A5A4638C90858

forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://rpc.sepolia.mantle.xyz \
  --private-key "$OPERATOR_PRIVATE_KEY" \
  --broadcast --chain-id 5003
```

### Верификация (Sourcify)

```bash
forge verify-contract <DEPLOYED_ADDRESS> \
  src/VectorMeritRegistry.sol:VectorMeritRegistry \
  --verifier sourcify \
  --chain-id 5003 \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    $OWNER_ADDRESS $ATTESTOR_ADDRESS)
```

### Аттестация

```bash
EVIDENCE_HASH=$(cast keccak "vector-hackathon-demo-agent-136")

cast send <DEPLOYED_ADDRESS> \
  "attestScore(uint256,uint16,bytes32)" \
  136 735 "$EVIDENCE_HASH" \
  --private-key "$ATTESTOR_PRIVATE_KEY" \
  --rpc-url https://rpc.sepolia.mantle.xyz
```

### Чтение

```bash
cast call <DEPLOYED_ADDRESS> \
  "latestScore(uint256)(uint16,bytes32,uint64,uint64,bool)" 136 \
  --rpc-url https://rpc.sepolia.mantle.xyz

cast call <DEPLOYED_ADDRESS> \
  "isEligible(uint256,uint16)(bool)" 136 700 \
  --rpc-url https://rpc.sepolia.mantle.xyz
```

---

## Безопасность

- Приватные ключи **НИКОГДА** не коммитятся в репозиторий.
- Все `.env` файлы исключены через `.gitignore`.
- Контракт использует OpenZeppelin Ownable для контроля доступа.
- Все входные данные валидируются; контракт "fail closed" на невалидных входах.
