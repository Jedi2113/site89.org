# Event Notification System Setup Guide

This document explains how to configure Discord webhook notifications for Site-89 events.

## Overview

The event notification system sends Discord notifications at four different times:

1. **3 days before** → Notifies @looking for rp role + tagged departments
2. **Day of event** → Notifies all RSVPed users
3. **30 minutes before** → Reminds all RSVPed users
4. **Event start** → Final notification to all RSVPed users

## Firebase Functions Configuration

### Required Webhook URLs

You need to configure webhook URLs using one of these methods:

#### Method 1: Firebase CLI (Recommended)

```bash
# Main events webhook (for all event notifications)
firebase functions:config:set discord.events_webhook_url="YOUR_EVENTS_WEBHOOK_URL"

# Role ID for @looking for rp mentions
firebase functions:config:set discord.looking_for_rp_role_id="YOUR_ROLE_ID"

# Department role IDs (these roles will be mentioned in 3-day announcements)
firebase functions:config:set discord.department_role_ids='{"AD":"1235374061396295701","TSD":"1235366964415959093","ScD":"1235366965413941378","SD":"1235366963690078359","IA":"1235374061291307119"}'
```

#### Method 2: Environment Variables (Firebase Console)

In the Firebase Console → Functions → Environment Variables:

- `DISCORD_EVENTS_WEBHOOK_URL` = Your events channel webhook URL
- `DISCORD_LOOKING_FOR_RP_ROLE_ID` = Your @looking for rp role ID
- `DISCORD_DEPARTMENT_ROLE_IDS` = JSON object with department role IDs

#### Method 3: Firestore Document (Fallback)

Create/update the document: `settings/integrations`

```javascript
{
  discordEventsWebhookUrl: "YOUR_WEBHOOK_URL",
  discordLookingForRpRoleId: "YOUR_ROLE_ID",
  discordDepartmentRoleIds: {
    "AD": "role_id_1",
    "TSD": "role_id_2",
    "ScD": "role_id_3",
    "SD": "role_id_4",
    "IA": "role_id_5"
  }
}
```

## How to Get Discord Webhook URLs

1. Go to your Discord server
2. Navigate to Server Settings → Integrations → Webhooks
3. Create a new webhook for your events channel
4. Copy the webhook URL

## How to Get Role IDs

1. In Discord, go to Server Settings → Roles
2. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
3. Right-click on a role (e.g., "@looking for rp", "@AD", "@TSD")
4. Select "Copy Role ID"
5. Repeat for each department role you want to mention in announcements

## Scheduled Functions

Four scheduled functions handle event notifications:

| Function Name | Schedule | Purpose |
|--------------|----------|---------|
| `checkEvents3DaysAway` | Daily at 00:00 | Announce events 3 days in advance, mentions @looking for rp and department roles |
| `checkEventsStartingNow` | Every 5 minutes | Final notification when event starts |

## Notification Tracking

The system automatically tracks which notifications have been sent by adding timestamp fields to event documents:

- `three_day_sent` - 3-day announcement timestamp
- `day_of_sent` - Day-of notification timestamp
- `thirty_min_sent` - 30-minute reminder timestamp
- `start_sent` - Start notification timestamp

This prevents duplicate notifications if functions run multiple times.

## User Requirements

For users to receive notifications, they must:

1. Have a Firebase account (authenticated)
2. Have linked their Discord user ID in their account settings (`/accounts/`)
3. Have an RSVP for the event (stored in `events/{eventId}/rsvps/{characterId}`)

The RSVP document must contain:
```javascript
{
  characterId: "character_doc_id",
  characterName: "Character Name",
  createdByUid: "firebase_user_id",
  createdByEmail: "user@example.com",
  createdAt: timestamp
}
```

## Deployment

After configuration, deploy the functions:

```bash
firebase deploy --only functions
```

Specific functions can be deployed individually:

```bash
firebase deploy --only functions:checkEvents3DaysAway
firebase deploy --only functions:checkEventsDayOf
firebase deploy --only functions:checkEvents30MinutesAway
firebase deploy --only functions:checkEventsStartingNow
```

## Testing

To test the notification system:

1. Create a test event with a start time matching one of the trigger windows
2. RSVP to the event with a character linked to your Discord account
3. Wait for the scheduled function to run (or manually trigger in Firebase Console)
4. Check the Firebase Functions logs for execution details
5. Verify Discord notifications are received

## Troubleshooting

### No notifications received

1. Check Firebase Functions logs for errors
2. Verify webhook URLs are correctly configured
3. Ensure user has Discord ID linked in `users/{uid}.discordUserId`
4. Confirm RSVP exists with valid `createdByUid`

### Duplicate notifications

- Check if notification tracking timestamps are being written to event documents
- Verify scheduled functions aren't running multiple times simultaneously

### Rate limiting errors

- Discord has rate limits (50 requests per second per webhook)
- The system includes 150ms delays between notifications
- For large events (100+ RSVPs), notifications may take a few minutes

## Example Notification Flow

**Event:** "SCP-173 Containment Breach Drill"
- **Departments:** TSD, SD
- **RSVPs:** 15 characters
- **Start Time:** March 10, 2026 at 18:00 ET

**March 7 at 00:00:**
- Main webhook posts to #events channel mentioning @looking for rp, @TSD, and @SD

**March 10 at 00:00:**
- 15 individual notifications sent to RSVPed users: "Event starts today!"

**March 10 at 17:30:**
- 15 individual reminders sent: "Event starting in 30 minutes!"

**March 10 at 18:00:**
- 15 final notifications sent: "Event starting NOW!"

## Additional Notes

- All times are calculated in EST/EDT (America/New_York timezone)
- The system uses account-level Discord linking (not per-character)
- Department webhooks are optional - the main webhook is sufficient for basic functionality
- Notification tracking prevents re-sending if deployment occurs during an event window
