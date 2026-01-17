# Telegram IPA Decrypt Bot

Telegram bot to download, decrypt and manage iOS IPA files via SSH/SFTP.

## Features

- **Download IPA**: Download apps from App Store using `ipatool`
- **Decrypt**: Decrypt installed apps using `TrollDecryptJB`
- **Install/Uninstall**: Install and uninstall apps using `ideviceinstaller`
- **Manage**: List installed applications
- **Automation**: Download and decrypt automatically in one command

## Requirements

- Node.js >= 18.0.0
- npm
- `ipatool` - Install from [ipatool](https://github.com/majd/ipatool) or `brew install ipatool`
- `ideviceinstaller` - Install from [libimobiledevice](https://github.com/libimobiledevice/libimobiledevice)
  - **macOS**: `brew install libimobiledevice`
  - **currently not support Windows**, Linux mayable to run, idk, haven't test on Linux yet... :/
- PHP 7.4+ with extensions:
  - `curl` extension (usually included)
  - `redis` extension (optional, for caching)
    - macOS: `brew install php-redis`
- Redis server (optional, for caching) 
    - macOS: `brew install redis` 
- Python 3.6+ with dependencies: `pip install -r requirements.txt`

### On iPhone (jailbroken):
- iOS 14 (jailbroken with checkra1n or unc0ver, not support Taurine/Odysseyra1n atm)
- OpenSSH with root access
- `TrollDecryptJB` - Get the deb from [TrollDecryptJB iOS 14 branch](https://github.com/34306/TrollDecryptJB/releases/tag/1.3.1.1) and install it.

## Installation

1. Clone repository:
```bash
git clone https://github.com/34306/tele-bot-ipa
cd tele-bot-ipa
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

4. Config `.env`:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_IDS=your_telegram_user_id

SSH_HOST=192.168.x.x
SSH_PORT=22
SSH_USER=root
SSH_PASSWORD=alpine

# Optional: ipatool path (default: ipatool)
IPATOOL_PATH=ipatool

# Optional: Arcade check service URL (default: http://localhost:8080/check-arcade.php)
ARCADE_CHECK_URL=http://localhost:8080/check-arcade.php

# Optional: Redis configuration (if using Redis for caching)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_TIMEOUT=0.8
```
For the USER_SESSION_STRING, you may need to use the `setup_telegram.py` to get the token, for the BOT token just chat with `@BotFather` in Telegram. For the Telegram API Hash thing just go to [https://my.telegram.org/apps](https://my.telegram.org/apps)

5. Build project:
```bash
npm run build
```

6. Run both services:

**Run both check-arcade and bot**
```bash
./start-all.sh
```

## Usage

### Available Commands

- `/start` - Start bot and show menu
- `/help` - Show help guide
- `/request <app-store-url>` - Download and decrypt app from App Store URL

## Common errors

### SSH Connection Errors
- Check if SSH is enabled on iPhone
- Verify IP address and password
- Makesure iPhone and your Mac are on the same network

### IPA Download Errors
- Makesure `ipatool` is installed
- You need to login into your Appstore account first by using:
    - `ipatool auth login -e <your_email>`

### Decryption Errors
- Makesure app is installed on iPhone
- Check if `TrollDecryptJB` is installed (see [TrollDecryptJB](https://github.com/34306/TrollDecryptJB/releases/tag/1.3.1.1))
- Some apps may not be decryptable (ServiceConnectionInterrupted, idk how to fix it yet, maybe in the future, for eg: Line app, you need decrypt in TrollDecryptJB UI)

### Installation Errors
- Makesure libmobiledevice is installed on your Mac
- Check if IPA file exists
- Verify trolldecryptjb cli on iPhone (you may use default path: /usr/local/bin/trolldecryptjb)

## Security

**Warning**: 
- DONOT upload your `.env` file (contain ALL of your Telegram TOKEN, added in `.ignore` file but just double check)
- Telegram is allow botuser but be careful with it, just in case...

## Credits

- [ipatool](https://github.com/majd/ipatool) - Tool to download IPA from App Store
- [TrollDecryptJB](https://github.com/34306/TrollDecryptJB/releases/tag/1.3.1.1) - Tool to decrypt iOS apps (CLI available at `/usr/local/bin/trolldecryptjb`)
- [ideviceinstaller](https://github.com/libimobiledevice/ideviceinstaller) - [ipa-bot](https://github.com/Geczy/ipa-bot)
