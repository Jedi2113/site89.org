# Analytics Dashboard - Implementation Guide

## Overview

The Analytics Dashboard is a comprehensive monitoring system designed to track and visualize key metrics for the SITE-89 project. It provides detailed insights into member growth, event attendance, financial performance, and other important project statistics.

## Access Control

**Authorized User:** `jedi21132@gmail.com`

Only this email address can:
- View the analytics dashboard
- Manage analytics data
- Add event markers to the member growth timeline
- Edit finance data

## Features

### 1. Member Growth Tracking
- **Visualization:** Interactive line chart showing cumulative member count over time
- **Functionality:**
  - View all-time growth (from Feb 2024)
  - Filter by year (2024, 2025, 2026)
  - Add event markers to highlight significant milestones (e.g., "Trailer Release")
  - Hover tooltips showing exact numbers
- **Data Source:** Firestore `characters` collection
- **Features:**
  - Tracks member creation dates
  - Cumulative count updated monthly
  - Visual markers for important events

### 2. Event Attendance
- **Visualization:** Bar chart showing attendance over the last 30 days
- **Functionality:**
  - Displays events hosted on the forum
  - Shows total attendance including original post and replies
  - Sorted chronologically
- **Data Source:** Firestore `forum-threads` collection
- **Features:**
  - Automatic attendance calculation
  - Monthly filtering available
  - Hover details for individual events

### 3. Month-over-Month (MoM) Growth
- **Visualization:** Bar chart with color coding (green for growth, red for decline)
- **Functionality:**
  - Shows new members added each month
  - Calculates growth percentage
  - Identifies trends and patterns
- **Data Source:** Firestore `characters` collection (creation dates)
- **Features:**
  - Historical data from Feb 2024 onwards
  - Percentage change calculation
  - Color-coded visualization

### 4. Finance Dashboard
- **Site Upkeep Costs:** Line chart showing monthly operational expenses
- **Founder Contributions:** List of founder names and contribution amounts
- **Budget Overview:** Total monthly budget with breakdown
- **Data Source:** Firestore `settings/finance` document
- **Features:**
  - Editable via admin panel
  - Tracks financial history
  - Support for multiple founders
  - Notes field for additional context

### 5. Events Hosted
- **Visualization:** Bar chart showing events hosted in the last year
- **Functionality:**
  - Groups events by month
  - Shows total count per month
  - Hover information available
- **Data Source:** Firestore `forum-threads` collection
- **Features:**
  - Automatic aggregation
  - Year-long history
  - Event details on demand

### 6. Summary Statistics
- **Total Members:** Current count with month-over-month change
- **Events This Month:** Count and comparison to previous month
- **MoM Growth Rate:** Percentage change in membership
- **Monthly Budget:** Total spending and current status

## File Structure

```
/analytics/
├── index.html                 # Main analytics dashboard
│
/admin/analytics/
├── index.html                 # Analytics data editor

/assets/css/
├── analytics.css              # Dashboard and editor styles

/assets/js/
├── analytics.js               # Main dashboard logic
├── analytics-editor.js        # Data management logic
│
/components/
├── navbar.html                # Updated with analytics link
```

## Firestore Data Structure

### settings/analytics
```json
{
  // Event markers for the timeline
  "markers": {
    "2024-07-15-timestamp": {
      "date": "2024-07-15",
      "title": "Trailer Release",
      "description": "Official trailer released",
      "createdAt": Timestamp
    }
  }
}
```

### settings/finance
```json
{
  "monthlyUpkeep": [
    { "month": "Jan", "amount": 150 },
    { "month": "Feb", "amount": 155 },
    ...
  ],
  "founderContributions": [
    { "name": "Founder 1", "amount": 100 },
    { "name": "Founder 2", "amount": 80 },
    ...
  ],
  "totalMonthlyBudget": 230,
  "notes": "Additional notes about finances..."
}
```

## API Endpoints

All data is pulled from Firestore collections:

1. **Members:** `characters` collection
   - Fields used: `createdAt`, `linkedUID`
   - Access: Public read, authorized create

2. **Events:** `forum-threads` collection
   - Fields used: `title`, `createdAt`, `replyCount`
   - Access: Public read, authenticated create

3. **Finance:** `settings/finance` document
   - Fields: All fields within
   - Access: Public read, admin write

4. **Analytics Settings:** `settings/analytics` document
   - Subcollection: `markers`
   - Access: Public read, admin write

## Usage Guide

### Viewing the Dashboard

1. Log in with email `jedi21132@gmail.com`
2. Click on your profile icon in the navbar
3. Select "Analytics" from the dropdown
4. The dashboard will load automatically

### Managing Finance Data

1. Navigate to `/admin/analytics/`
2. Or from the analytics dashboard, look for "Edit Finance Data" option
3. Add/edit monthly upkeep costs:
   - Enter month abbreviation (e.g., "Jan")
   - Enter amount in dollars
   - Click "Save All Changes"
4. Manage founder contributions:
   - Enter founder name
   - Enter contribution amount
   - Click "Save All Changes"
5. Update budget settings:
   - Enter total monthly budget
   - Add financial notes if needed
   - Click "Save All Changes"

### Adding Event Markers

1. On the Member Growth chart
2. Click "Add Event Marker" button
3. Select the date of the significant event
4. Enter event title (e.g., "Trailer Release")
5. Optional: Add description
6. Click "Add Marker"
7. The chart will update automatically

### Filtering Member Growth

1. Use the year tabs above the Member Growth chart
2. "All Time" shows data from Feb 2024 onwards
3. "2024", "2025", "2026" show year-specific data
4. Chart updates immediately

## Security & Permissions

### Firestore Rules

The analytics system is protected by these rules:

```
// Only jedi21132@gmail.com can write analytics data
match /settings/analytics {
  allow read: if true;  // Public read
  allow write: if request.auth.token.email == 'jedi21132@gmail.com';
}

match /settings/finance {
  allow read: if true;  // Public read
  allow write: if request.auth.token.email == 'jedi21132@gmail.com';
}
```

### Frontend Security

- Access checks happen on page load
- Non-authorized users are redirected
- Edit functions check authorization
- All data mutations are validated

## Chart Details

### Chart.js Library
- Version: 3.9.1
- Used for all visualizations
- Responsive design
- Dark mode compatible

### Chart Types
1. **Member Growth:** Line chart with fill
2. **Event Attendance:** Bar chart
3. **MoM Growth:** Bar chart with color coding
4. **Site Upkeep:** Line chart
5. **Events Hosted:** Bar chart

## Data Refresh

- Charts are rendered on page load
- Firebase listeners could be added for real-time updates
- Manual refresh by reloading the page
- All data is read from Firestore on each dashboard visit

## Styling & Theme

The dashboard supports both light and dark themes:
- Automatically follows user's theme preference
- Consistent with SITE-89 design system
- Uses CSS variables for theming
- Responsive grid layouts
- Mobile-optimized interface

## Future Enhancements

Possible improvements:

1. **Real-time Updates:** WebSocket listeners for live data
2. **Custom Date Ranges:** Allow users to select specific date ranges
3. **Data Export:** CSV/PDF export functionality
4. **Email Reports:** Automated weekly/monthly reports
5. **Additional Metrics:**
   - User retention rates
   - Forum activity metrics
   - Department-specific statistics
   - Anomaly creation trends
6. **Advanced Filtering:** Filter by department, rank, etc.
7. **Predictive Analytics:** Trend forecasting
8. **Comparative Analysis:** Year-over-year comparisons

## Troubleshooting

### Dashboard Not Loading
- Check if you're logged in as `jedi21132@gmail.com`
- Clear browser cache
- Check Firestore connectivity

### Charts Not Displaying
- Ensure Chart.js library loaded
- Check browser console for errors
- Verify Firestore rules are configured

### Data Not Saving
- Confirm you're using the authorized email
- Check Firestore rules allow writes
- Verify network connectivity
- Check browser console for error messages

### Finance Data Not Updating
- Refresh the page after saving
- Check if data was actually saved in Firestore
- Verify the finance collection/document exists

## Contact & Support

For issues or feature requests related to the analytics system, contact the administrator at `jedi21132@gmail.com`.

---

**Last Updated:** January 2026
**Version:** 1.0
