# Trunk Debug Commands

Target root resolution order:
1. `SHOPWARE_ROOT` (if set)
2. current command directory (`$PWD`)
3. GitHub/remote references as fallback context only

## Use a root variable

```bash
ROOT="${SHOPWARE_ROOT:-$PWD}"
cd "$ROOT"
```

## Runtime and environment

```bash
php -v
composer --version
php bin/console --version
```

## Cache and build

```bash
php bin/console cache:clear
php bin/console cache:warmup
php bin/console assets:install
```

## Plugin and app state

```bash
php bin/console plugin:list
php bin/console plugin:refresh
php bin/console app:list
```

## Migrations and index

```bash
php bin/console database:migrate --all
php bin/console dal:refresh:index
```

## Queue and scheduled tasks

```bash
php bin/console messenger:stats
php bin/console scheduled-task:list
```

## Logs

```bash
tail -n 200 var/log/prod-*.log
tail -n 200 var/log/dev-*.log
```
