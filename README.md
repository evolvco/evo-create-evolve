# create-evolve

Public launcher for Evolv's authorized developer workspace scaffolder.

## Usage

```bash
npm create evolve@latest my-app
```

This package is intentionally small. It checks that GitHub authentication is available, fetches Evolv's private implementation for authorized users, and forwards the command arguments to that implementation.

## Requirements

- Node `>= 18`
- GitHub CLI (`gh`)
- A GitHub account with access to Evolv's private developer tooling

If your account is not authorized, the launcher exits without downloading the private implementation.

## Source

https://github.com/evolvco/evo-create-evolve

## License

UNLICENSED.
