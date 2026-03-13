const admin = require('firebase-admin');

// Initialize admin SDK with default credentials
admin.initializeApp({
  projectId: 'site-89-2d768'
});

const db = admin.firestore();

async function setupDiscordConfig() {
  try {
    const config = {
      discordEventsWebhookUrl: 'https://discord.com/api/webhooks/1479885470216356098/xD9Et7LyKEqqaq3S8ESNIyUa3wqnqXvtS7Z-ulfvgcewkcKOn5Qn4yg4DdxRLfyPN3EN',
      discordDebugMode: true,
      discordLookingForRpRoleId: '1364330844528836679',
      discordDepartmentRoleIds: {
        AD: '1235374061396295701',
        TSD: '1235366964415959093',
        ScD: '1235366965413941378',
        SD: '1235366963690078359',
        IA: '1235374061291307119'
      }
    };

    await db.doc('settings/integrations').set(config, { merge: true });
    console.log('✅ Discord configuration saved to Firestore!');
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('❌ Error saving config:', error);
    process.exit(1);
  }
}

setupDiscordConfig();
