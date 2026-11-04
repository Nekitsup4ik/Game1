# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Authentication & Email Verification**: All reads and writes require an authenticated user (`request.auth != null`) with a verified email (`request.auth.token.email_verified == true`).
2. **No Collection Scraping (`list` Disabled)**: Direct collection list queries are disabled (`allow list: if false;`) across `/lobbies/{lobbyId}`, `/rooms/{roomId}`, and `/rooms/{roomId}/players/{playerId}`. Clients read `/lobbies/main` and individual rooms/players by ID via `get`.
3. **Master Gate Relational Sync**: A `RoomPlayer` document `/rooms/{roomId}/players/{playerId}` can only be read or modified if the authenticated user is currently in the parent `/rooms/{roomId}` document's `memberUids` list (`request.auth.uid in get(...).data.memberUids`).
4. **Atomicity Guarantee (`existsAfter` / `getAfter`)**:
   - Creating a `MatchRoom` (`/rooms/{roomId}`) requires atomically creating the host's `RoomPlayer` document (`/rooms/{roomId}/players/{request.auth.uid}`) in the same batch.
   - Creating a `RoomPlayer` (`/rooms/{roomId}/players/{playerId}`) requires that the parent `MatchRoom` exists after the batch and includes `request.auth.uid` in `memberUids`.
5. **Terminal State Locking**: Once a `MatchRoom` reaches `status == 'finished'`, all subsequent updates to both the `MatchRoom` and its `RoomPlayer` subcollection documents are permanently denied.
6. **Strict Schema, Key Allowlisting & Temporal Integrity**: Every `create` and `update` invokes `isValidLobbyDirectory`, `isValidMatchRoom`, or `isValidRoomPlayer`, enforces `hasAll` + `hasOnly` keys, validates string lengths and numeric bounds, preserves immutable fields (`roomId`, `hostUid`, `createdAt`, etc.), and requires `request.time` for `createdAt` / `updatedAt`.

---

## 2. The "Dirty Dozen" Payloads

1. **Payload 1 (Identity Spoofing on Room Create)**: User `uid_attacker` creates `/rooms/room_1` with `hostUid: "uid_victim"`. -> `PERMISSION_DENIED`
2. **Payload 2 (Unverified Email Spoof)**: User with `email_verified: false` attempts to create `/rooms/room_1`. -> `PERMISSION_DENIED`
3. **Payload 3 (Shadow Field Injection on Room Update)**: Member updates `/rooms/room_1` including an undeclared field `isAdmin: true`. -> `PERMISSION_DENIED`
4. **Payload 4 (Orphaned Room Creation without Player Atomic Batch)**: User creates `/rooms/room_1` without creating `/rooms/room_1/players/{uid}` in the same transaction/batch. -> `PERMISSION_DENIED`
5. **Payload 5 (Non-Host Starting Match)**: Non-host member transitions `/rooms/room_1` from `status: "waiting"` to `status: "playing"`. -> `PERMISSION_DENIED`
6. **Payload 6 (Terminal State Mutation)**: Host or member attempts to update `redScore` on `/rooms/room_1` when `existing().status == "finished"`. -> `PERMISSION_DENIED`
7. **Payload 7 (ID Poisoning / Oversized String)**: Attacker attempts to create a room with a 200-character `title` or invalid characters in `roomId`. -> `PERMISSION_DENIED`
8. **Payload 8 (Jersey Number Out of Bounds)**: Player sets `jerseyNumber: 150` or `jerseyNumber: 0` (must be `1..99`). -> `PERMISSION_DENIED`
9. **Payload 9 (Non-Member Subcollection Read/Write - Master Gate Violation)**: Authenticated user not in `room.memberUids` attempts to `get` or `update` `/rooms/room_1/players/uid_victim`. -> `PERMISSION_DENIED`
10. **Payload 10 (Immutable Field Tampering)**: Room member attempts to change `hostUid` or `createdAt` during an update to `/rooms/room_1`. -> `PERMISSION_DENIED`
11. **Payload 11 (Forged Client Timestamp)**: Client sends a past or future timestamp for `updatedAt` instead of `request.time`. -> `PERMISSION_DENIED`
12. **Payload 12 (Unauthorized Collection List Scraping)**: Authenticated user executes a `list` query across `/rooms` or `/rooms/room_1/players`. -> `PERMISSION_DENIED`
