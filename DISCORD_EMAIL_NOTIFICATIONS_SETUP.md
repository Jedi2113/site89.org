# Discord Email Notifications Setup Guide

This guide explains how to set up Discord notifications for Site-89 email system, so users get pinged in a Discord channel when **any of their characters** receive emails.

## System Overview

When a new email is created in Firestore, a Firebase Function automatically:
1. Looks up each recipient character by email address
2. Finds which Site-89 account owns that character (via `linkedUID`)
3. Checks if that account has a linked Discord User ID
4. Sends a notification to a Discord webhook with an @mention

**Key Feature:** Discord is linked at the **account level**, not per-character. This means one Discord link covers all your characters!

## Setup Steps

### 1. Create Discord Webhook

1. In your Discord server, navigate to the `#email-notifier` channel (or create it)
2. Right-click the channel → **Edit Channel**
3. Go to **Integrations** → **Webhooks**
4. Click **New Webhook** or **Create Webhook**
5. Give it a name like "Site-89 Email Notifier"
6. Optionally set an avatar
7. **Copy the Webhook URL** - you'll need this for the next step

### 2. Configure Firebase Function

You need to set the webhook URL as an environment variable for your Firebase Functions.

**Option A: Using Firebase CLI**

```bash
firebase functions:config:set discord.webhook_url="YOUR_WEBHOOK_URL_HERE"
```

Then redeploy your functions:

```bash
firebase deploy --only functions
```

**Option B: Using Firebase Console (Recommended)**

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Navigate to **Functions** → **Configuration**
4. Add a new environment variable:
   - Key: `DISCORD_WEBHOOK_URL`
   - Value: Your Discord webhook URL

**Option C: Using .env file (for local development)**

1. Create a `.env` file in the `functions` directory
2. Add: `DISCORD_WEBHOOK_URL=your_webhook_url_here`
3. Update `functions/index.js` to load from `.env`:
   ```javascript
   require('dotenv').config();
   ```
4. Install dotenv: `npm install dotenv` (in the functions directory)

### 3. Deploy Firebase Functions

Deploy your functions to Firebase:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

Monitor the deployment for any errors.

### 4. Test the Integration

1. **Link a Discord Account:**
   - Log into Site-89
   - Go to `/accounts/`
   - In the Discord Integration section, enter your Discord User ID
   - Click "Link Discord Account"

2. **Find Your Discord User ID:**
   - In Discord: Settings → Advanced → Enable "Developer Mode"
   - Right-click your profile picture → "Copy User ID"

3. **Test Email Notification:**
   - Send an email to your character's email address in Site-89
   - You should receive a Discord notification with an @mention in `#email-notifier`

## Features

### What's Included

✅ Discord linking UI in accounts page  
✅ Validation of Discord User IDs (17-20 digits)  
✅ Automatic Discord notifications on new emails  
✅ Rich embed messages with email preview  
✅ @mention to notify the user  
✅ Rate limiting (100ms between notifications)  
✅ Error handling and logging  
✅ Link/Unlink functionality  

### Discord Notification Format

```
@YourUsername 📬 New Email Received

To: [Character Name]
Subject: [Email Subject]
From: [Sender Name/Email]
Preview: [First 200 characters of email body]

🔗 Check your Site-89 Mailbox
```

## Database Schema

### Users Collection Updates

Each user document (keyed by Firebase Auth UID) can now include:

```javascript
{
  email: "user@example.com", // Firebase Auth email
  discordUserId: "123456789012345678", // Discord User ID (string)
  discordLinkedAt: "2026-03-06T12:00:00.000Z", // ISO timestamp
  // ... other user fields
}
```

**Note:** Discord is linked at the account level in the `users` collection, NOT in individual character documents. This ensures one Discord link covers all characters owned by that account.

## Security Considerations

### Webhook URL Security
- **Never commit webhook URLs to git** - they grant posting access to your Discord channel
- Store them in Firebase Functions config or environment variables
- If accidentally exposed, regenerate the webhook in Discord channel settings

### Discord User ID Validation
- Client-side validates format (17-20 numeric digits)
- Users can only link Discord IDs to their own accounts
- Firestore rules enforce that users can only update their own user documents

### Duplicate Notification Prevention
- If multiple characters owned by the same account receive the same email, only one Discord notification is sent
- The function tracks which accounts have been notified per email

### Rate Limiting
- Function includes 100ms delay between Discord notifications
- Discord webhooks have rate limits (30 requests per minute per webhook)
- For high-volume email systems, consider implementing a queue

## Troubleshooting

### No notifications received?

**Check Firebase Functions logs:**
```bash
firebase functions:log --only onEmailCreated
```

Look for:
- ✅ Success messages showing Discord notifications sent
- ❌ Error messages about webhook failures
- ⚠️ Warnings about missing webhook URL or unlinked Discord accounts

**Common issues:**

1. **Webhook URL not configured:**
   - Error: "Discord webhook URL not configured"
   - Solution: Set the environment variable as described in Step 2

2. **Character has no email:**
   - Error: "No character found for email"
   - Solution: Ensure character has an email in Firestore

3. **Character has no linked account:**
   - Error: "Character has no linked account"
   - Solution: Ensure character has a `linkedUID` field pointing to a Firebase Auth user

4. **Discord not linked:**
   - Warning: "User account has no Discord linked"
   - Solution: User needs to link their Discord ID in `/accounts/`

4. **Invalid Discord User ID:**
   - Error during linking
   - Solution: Ensure Discord User ID is 17-20 numeric digits

5. **Webhook returns 404:**
   - The webhook was deleted or URL is incorrect
   - Solution: Create a new webhook and update the configuration

### Testing without deploying

You can test locally using Firebase Emulators:

```bash
firebase emulators:start --only functions,firestore
```

## Maintenance

### Webhook Rotation
If you need to change the webhook URL:

1. Create a new webhook in Discord
2. Update the Firebase Functions config with the new URL
3. Redeploy functions
4. Delete the old webhook in Discord

### Monitoring Usage
- Check Firebase Functions dashboard for invocation count
- Monitor Discord webhook usage in Discord server settings
- Set up Firebase Functions alerts for errors

## Additional Features (Optional)

### Per-Character Notification Preferences
If you want users to control which characters trigger notifications:

```javascript
// In users collection
{
  discordUserId: "123...",
  notificationSettings: {
    enabledCharacters: ["char_id_1", "char_id_2"], // Only these characters trigger notifications
    muteAll: false
  }
}
```

### Customizable Notifications
Consider adding user preferences:

```javascript
{
  discordNotifications: {
    enabled: true,
    mentionMe: true,
    showPreview: true,
    onlyImportant: false
  }
}
```

### Notification Types
Extend to other events:
- Bank transactions (already has notifications in functions)
- Incident report assignments
- Forum mentions
- Event invitations

## Support

For issues or questions:
1. Check Firebase Functions logs
2. Verify webhook URL is correct
3. Test Discord User ID validity
4. Review Firestore rules for character updates

---

**Last Updated:** March 6, 2026
