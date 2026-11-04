# standards/

revvel-standards stays the single source of truth. Members read it from here as a git submodule, so there's one copy of the rules, not two.

Add it once, from the GIT-FLEET root:

```bash
git submodule add https://github.com/midnghtsapphire/revvel-standards standards/revvel-standards
```

Update to the latest rules:

```bash
git submodule update --remote standards/revvel-standards
```

Until it's added, runs still work; the run report lists the missing files under `missing_context`.
