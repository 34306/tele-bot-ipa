#!/usr/bin/env python3
"""
Simple Telegram Session Setup Script
Generates session string for the IPA Bot
"""

import os
import sys
import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

def load_env():
    """Load environment variables from .env file"""
    env_vars = {}
    try:
        with open('.env', 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    env_vars[key] = value
    except FileNotFoundError:
        print(".env file not found!")
        sys.exit(1)
    return env_vars

async def setup_session():
    print("Telegram Session Setup for IPA Bot")
    print("=====================================")
    print("This will authenticate your personal Telegram account")
    print("Make sure you have Telegram Premium for 4GB file uploads\n")

    # Load environment variables
    env_vars = load_env()
    
    try:
        api_id = int(env_vars.get('TELEGRAM_API_ID', ''))
        api_hash = env_vars.get('TELEGRAM_API_HASH', '')
    except (ValueError, KeyError):
        print("Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env file")
        sys.exit(1)

    if not api_id or not api_hash:
        print("Invalid API_ID or API_HASH in .env file")
        sys.exit(1)

    print(f"Using API_ID: {api_id}")
    print(f"Using API_HASH: {api_hash[:8]}...")

    # Create client with string session
    client = TelegramClient(StringSession(), api_id, api_hash)

    try:
        print("\nStarting authentication...")
        await client.start()

        if await client.is_user_authorized():
            print("Authentication successful!")
            
            # Get user info
            me = await client.get_me()
            print(f"Authenticated as: {me.first_name} {me.last_name or ''}")
            print(f"Username: @{me.username or 'no username'}")
            print(f"User ID: {me.id}")
            
            # Check Premium status
            if hasattr(me, 'premium') and me.premium:
                print("Telegram Premium: YES - can upload up to 4GB files")
            else:
                print("Telegram Premium: NO - limited to 2GB files")
                print("Consider upgrading to Telegram Premium for larger file uploads")

            # Save session string
            session_string = client.session.save()
            
            # Save to .env file
            with open('.env', 'a') as f:
                f.write(f"\nUSER_SESSION_STRING={session_string}\n")
            
            print(f"\nSession string saved to .env file")
            print("Setup completed! You can now upload large files.")
            
            # Test backup channel access
            backup_channel = env_vars.get('BACKUP_CHANNEL_ID', '')
            if backup_channel:
                try:
                    print(f"\nTesting access to backup channel: {backup_channel}")
                    entity = await client.get_entity(int(backup_channel))
                    print("Backup channel access confirmed!")
                except Exception as e:
                    print(f"Warning: Cannot access backup channel: {e}")
                    print("Make sure your account is added to the backup channel")
            
        else:
            print("Authentication failed")
            
    except KeyboardInterrupt:
        print("\nSetup cancelled by user")
    except Exception as e:
        print(f"\nSetup failed: {e}")
        print("\nTroubleshooting:")
        print("1. Make sure your phone number includes country code (+84987654321)")
        print("2. Check Telegram app for verification code")
        print("3. If you have 2FA, enter your password correctly")
        print("4. Ensure you have internet connection")
    finally:
        await client.disconnect()

def main():
    # Check if Python is available
    if sys.version_info < (3, 6):
        print("Python 3.6+ is required")
        sys.exit(1)
    
    # Check if telethon is installed
    try:
        import telethon
        print(f"Telethon version: {telethon.__version__}")
    except ImportError:
        print("Telethon not installed. Installing...")
        os.system("pip3 install telethon")
        print("Telethon installed. Please run the script again.")
        sys.exit(0)
    
    # Run the setup
    asyncio.run(setup_session())

if __name__ == "__main__":
    main()