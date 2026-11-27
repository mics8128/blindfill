# Compared with common approaches

How each approach typically handles the password when an AI agent has to sign in. Products vary, so check the one
you use.

| Approach                                | Password enters the model's context                             | Who decides where it's typed                         | Where it runs                     |
| --------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| blindfill                               | Not by design: secret values are fill-only                      | The vault item, checked against the browser's origin | Your machine, with your vault CLI |
| Password in the prompt                  | Yes                                                             | The model                                            | Wherever the model runs           |
| Password manager CLI given to the agent | Usually: the CLI prints plaintext to its caller                 | The model                                            | Your machine                      |
| Browser extension autofill              | Usually not at fill time; depends on what the agent reads later | The extension's site matching                        | Your browser                      |
| Cloud browser service                   | Depends on the vendor                                           | Varies                                               | The vendor's infrastructure       |

The post-fill lock covers blindfill's own interfaces only. Another tool attached to the same browser can still read the
page ([SECURITY.md](../SECURITY.md), point 3).
