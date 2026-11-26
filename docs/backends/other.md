# Other backends (all **blind-written / unverified**)

`op` (1Password CLI), `rbw`, `pass`, `gopass`, `keepassxc` (keepassxc-cli), `secret-service` (secret-tool).
They were written from vendor documentation and pass the shared contract suite **against recorded fixtures only**.
They have never touched a real vault. blindfill prints an "unverified" notice when you use one.

Run `blindfill backend selftest <id>`: it creates a fake item, round-trips it, and removes it. Use a throwaway store.
If it passes on your machine, please open an issue to promote the backend to `community-verified`.

| id             | binary            | notes                                                                             |
| -------------- | ----------------- | --------------------------------------------------------------------------------- |
| op             | `op`              | needs `op signin` / desktop integration                                           |
| rbw            | `rbw`             | agent must already be unlocked                                                    |
| pass / gopass  | `pass` / `gopass` | `url:`, `username:` lines and `otpauth://` parsed from the entry                  |
| keepassxc      | `keepassxc-cli`   | `BLINDFILL_KEEPASS_DB`, `BLINDFILL_KEEPASS_KEYFILE`, `BLINDFILL_KEEPASS_PASSWORD` |
| secret-service | `secret-tool`     | attribute-based lookup                                                            |
