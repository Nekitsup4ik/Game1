/**
 * Firestore Security Rules Test Specification (Dirty Dozen Verification)
 * Verifies that all 12 adversarial payloads defined in security_spec.md return PERMISSION_DENIED.
 */

export interface DirtyPayloadTestCase {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: DirtyPayloadTestCase[] = [
  {
    id: 1,
    name: 'Identity Spoofing on Room Create',
    collectionPath: '/rooms/room_1',
    operation: 'create',
    auth: { uid: 'uid_attacker', email_verified: true },
    payload: { hostUid: 'uid_victim', roomId: 'room_1' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Spoof',
    collectionPath: '/rooms/room_1',
    operation: 'create',
    auth: { uid: 'uid_attacker', email_verified: false },
    payload: { hostUid: 'uid_attacker', roomId: 'room_1' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Shadow Field Injection on Room Update',
    collectionPath: '/rooms/room_1',
    operation: 'update',
    auth: { uid: 'uid_host', email_verified: true },
    payload: { redScore: 1, isAdmin: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Orphaned Room Creation without Player Atomic Batch',
    collectionPath: '/rooms/room_orphan',
    operation: 'create',
    auth: { uid: 'uid_host', email_verified: true },
    payload: { roomId: 'room_orphan', hostUid: 'uid_host' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Non-Host Starting Match',
    collectionPath: '/rooms/room_1',
    operation: 'update',
    auth: { uid: 'uid_guest', email_verified: true },
    payload: { status: 'playing' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Terminal State Mutation on Finished Room',
    collectionPath: '/rooms/room_finished',
    operation: 'update',
    auth: { uid: 'uid_host', email_verified: true },
    payload: { redScore: 10 },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Oversized Title / Resource Poisoning',
    collectionPath: '/rooms/room_1',
    operation: 'create',
    auth: { uid: 'uid_host', email_verified: true },
    payload: { title: 'A'.repeat(250) },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Jersey Number Out of Bounds (150)',
    collectionPath: '/rooms/room_1/players/uid_host',
    operation: 'create',
    auth: { uid: 'uid_host', email_verified: true },
    payload: { jerseyNumber: 150 },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Non-Member Subcollection Read (Master Gate Violation)',
    collectionPath: '/rooms/room_1/players/uid_host',
    operation: 'get',
    auth: { uid: 'uid_outsider', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Immutable Field Tampering (hostUid)',
    collectionPath: '/rooms/room_1',
    operation: 'update',
    auth: { uid: 'uid_host', email_verified: true },
    payload: { hostUid: 'uid_other' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Forged Client Timestamp',
    collectionPath: '/rooms/room_1',
    operation: 'update',
    auth: { uid: 'uid_host', email_verified: true },
    payload: { updatedAt: '2020-01-01T00:00:00Z' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unauthorized Collection List Scraping',
    collectionPath: '/rooms',
    operation: 'list',
    auth: { uid: 'uid_host', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
];
