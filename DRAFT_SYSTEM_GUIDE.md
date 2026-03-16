# Anomaly Draft System Guide

## Overview
The anomaly draft system allows characters to save their work-in-progress anomaly documents without publishing them publicly. Each draft is tied to a specific character and only that character can view, edit, or delete it.

## Features

### 1. Save as Draft
- Click the **"Save Draft"** button to save your current work
- Drafts are automatically named based on the item number (e.g., "Draft: SCP-131")
- If no item number is provided, it will be named "Draft: Untitled Anomaly"
- The URL will update to include the draft ID, so you can bookmark it

### 2. View Your Drafts
- Click the **"My Drafts"** button to see all drafts for your current character
- Drafts are sorted by most recently modified
- Each draft shows:
  - Draft title
  - Last modified date and time

### 3. Load a Draft
- From the "My Drafts" modal, click **"Load"** to open a draft
- The form will be populated with the draft's data
- A **"DRAFT"** indicator appears next to the page title
- A **"Delete Draft"** button becomes available

### 4. Publish a Draft
- When you're ready, click **"Publish Draft"** (or "Publish Anomaly" if not editing a draft)
- The anomaly will be published to the main collection
- The draft will be automatically deleted
- You'll receive a link to view the published anomaly

### 5. Delete a Draft
- While editing a draft, click the **"Delete Draft"** button
- Confirm the deletion (this cannot be undone)
- The form will be cleared

### 6. Delete from Modal
- In the "My Drafts" modal, click the **"Delete"** button next to any draft
- This allows you to clean up old drafts without loading them

## Important Notes

### Character-Specific
- Drafts are tied to the character you have selected
- Each character has their own separate drafts
- You cannot see drafts from other characters, even your own alts
- Make sure you have the correct character selected before creating drafts

### Security
- Only you can access your character's drafts
- Drafts are stored in a separate Firestore collection (`anomaly_drafts`)
- Publishing permissions still apply (Level 5 or ScD/R&D required)
- Draft saving requires you to be logged in and have a character selected

### URL Parameters
- `?draft=<draftId>` - Loads a specific draft
- `?id=<itemNumber>` or `?item=<itemNumber>` - Loads a published anomaly
- These parameters are automatically managed by the system

## Workflow Example

1. **Start Writing**: Go to `/anomalies/new/` and start filling out the form
2. **Save Draft**: Click "Save Draft" to save your progress
3. **Come Back Later**: The URL now includes your draft ID - bookmark it or come back through "My Drafts"
4. **Continue Editing**: Make changes and click "Save Draft" again to update
5. **Publish**: When ready, click "Publish Draft" to make it public
6. **Clean Up**: Old drafts can be deleted from the "My Drafts" modal

## Technical Details

### Data Structure
Each draft contains:
- `draftId` - Unique identifier
- `characterId` - ID of the character who created it
- `characterName` - Display name of the character
- `createdByUid` - Firebase user ID
- `createdByEmail` - User's email
- All form fields (itemNumber, containmentClass, etc.)
- `createdAt` and `updatedAt` timestamps

### Firestore Collection
- Collection: `anomaly_drafts`
- Indexed by: `characterId`, `updatedAt`
- Security rules ensure character-level privacy

### Browser Storage
- Character selection is stored in localStorage as `selectedCharacter`
- No draft data is stored locally - all data is in Firestore

## Future Enhancements
- Auto-save functionality (periodic background saves)
- Draft sharing between characters with permissions
- Version history for drafts
- Draft templates
- Export/import drafts

---

**Last Updated:** February 11, 2026  
**Version:** 1.0
