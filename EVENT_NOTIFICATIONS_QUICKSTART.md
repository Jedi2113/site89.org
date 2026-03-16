# Quick Setup Commands

## Step 1: Configure Discord Webhooks

Replace the placeholder values with your actual Discord webhook URLs and role IDs:

```bash
# Main events webhook (required)
firebase functions:config:set discord.events_webhook_url="https://discord.com/api/webhooks/YOUR_WEBHOOK_HERE"

# Looking for RP role ID (required for 3-day announcements)
firebase functions:config:set discord.looking_for_rp_role_id="1234567890123456789"

# Department role IDs (optional - will be mentioned in 3-day announcements)
firebase functions:config:set discord.department_role_ids='{"AD":"1234567890123456789","TSD":"1234567890123456789","ScD":"1234567890123456789","SD":"1234567890123456789","IA":"1234567890123456789"}'

# Debug mode (optional - shows plaintext role names instead of pinging)
firebase functions:config:set discord.debug_mode="true"
```

**Debug Mode:** When enabled, notifications will show `@RoleName (debug:role_id)` instead of actually pinging roles. Perfect for testing without spamming Discord!

## Step 2: Verify Configuration

```bash
firebase functions:config:get
```

## Step 3: Deploy Functions

```bash
# Deploy all functions
firebase deploy --only functions

# Or deploy only the new event notification functions
firebase deploy --only functions:checkEvents3DaysAway,functions:checkEventsDayOf,functions:checkEvents30MinutesAway,functions:checkEventsStartingNow
```

## Step 4: Monitor Deployment

Check the Firebase Console for deployment status and logs:
https://console.firebase.google.com/project/YOUR_PROJECT/functions

## Testing

1. Create a test event at https://site89.org/events/ with a start time:
   - For 3-day test: Set start time to 3 days from now
   - For day-of test: Set start time to today
   - For 30-min test: Set start time to 30-45 minutes from now
   - For start test: Set start time to current time ±5 minutes

2. RSVP to the event with a character linked to your Discord account

3. Wait for the scheduled function to run (or manually trigger in Functions console)

4. Check Discord for notifications

## How to Get Discord Webhook URL

1. Open Discord, go to Server Settings
2. Navigate to Integrations → Webhooks
3. Click "New Webhook" or select an existing one
4. Choose the channel (e.g., #events)
5. Copy the Webhook URL

## How to Get Role IDs

1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Go to Server Settings → Roles
3. Right-click a role (e.g., "@looking for rp", "@AD", "@TSD")
4. Click "Copy Role ID"
5. Repeat for each department role you want to mention

## Troubleshooting

If notifications aren't working:

```bash
# Check function logs
firebase functions:log

# Check recent executions
firebase functions:log --only checkEvents3DaysAway
firebase functions:log --only checkEventsDayOf
firebase functions:log --only checkEvents30MinutesAway
firebase functions:log --only checkEventsStartingNow
```

Common issues:
- ❌ Webhook URL not configured → Set via commands above
- ❌ User has no Discord linked → Link Discord at /accounts/
- ❌ No RSVPs → RSVP to test event
- ❌ Wrong time zone → Events use America/New_York (ET)

## Debug Panel

For admins (clearance 4+), a debug panel appears at the top of the events page with buttons to manually trigger notifications:

- **Test 3-Day** - Sends 3-day announcement for all upcoming events
- **Test Day-Of** - Sends day-of notification for selected event (click event first)
- **Test 30-Min** - Sends 30-minute reminder for selected event
- **Test Start** - Sends start notification for selected event

All manually triggered notifications include `[DEBUG TRIGGER]` in the message and `[MANUAL TEST]` in the footer.

**Enable Debug Mode** to avoid actually pinging roles:
```bash
firebase functions:config:set discord.debug_mode="true"
firebase deploy --only functions
```

When debug mode is ON, you'll see `@looking for rp (debug:123456789)` instead of actual pings.