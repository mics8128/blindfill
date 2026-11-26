/** One fake item every backend fixture must be able to represent. All values are fake. */
export const FAKE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Fake Shop',
  username: 'alice@example.test',
  password: 'CANARY-pw-Zx9!q7 &Lm=4',
  uri: 'https://shop.example.test/login',
  hidden: { name: 'pin', value: 'CANARY-pin-8841' },
  text: { name: 'store_id', value: 'S-1234' },
  totpSeed: 'JBSWY3DPEHPK3PXP',
  decoyId: '22222222-2222-4222-8222-222222222222',
  decoyUri: 'https://other.example.test/',
  androidId: '33333333-3333-4333-8333-333333333333',
  androidPkg: 'com.example.shop',
  missingId: '99999999-9999-4999-8999-999999999999',
};

export const SECRET_NEEDLES = [FAKE.password, FAKE.hidden.value, FAKE.totpSeed];

/** Bitwarden-shaped fixture (also used by the mock bw binary and by rbw/op converters). */
export function bwFixtureItems() {
  return [
    {
      id: FAKE.id,
      type: 1,
      name: FAKE.name,
      notes: 'CANARY-notes-should-stay-hidden',
      login: {
        username: FAKE.username,
        password: FAKE.password,
        totp: FAKE.totpSeed,
        uris: [{ uri: FAKE.uri, match: null }],
      },
      fields: [
        { name: FAKE.text.name, value: FAKE.text.value, type: 0 },
        { name: FAKE.hidden.name, value: FAKE.hidden.value, type: 1 },
        { name: 'blindfill.submit', value: 'once', type: 0 },
        { name: 'blindfill.rules', value: '{"v":1}', type: 0 },
      ],
    },
    {
      id: FAKE.decoyId,
      type: 1,
      name: 'Other Site',
      login: { username: 'bob', password: 'CANARY-decoy-0000', uris: [{ uri: FAKE.decoyUri, match: 1 }] },
    },
    {
      id: FAKE.androidId,
      type: 1,
      name: 'Fake Android App',
      login: {
        username: 'carol',
        password: 'CANARY-android-1111',
        uris: [{ uri: `androidapp://${FAKE.androidPkg}`, match: null }],
      },
      fields: [{ name: 'blindfill.signers', value: 'AA:BB:CC:DD', type: 0 }],
    },
  ];
}
