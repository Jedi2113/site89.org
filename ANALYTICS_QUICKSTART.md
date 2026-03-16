# Analytics Dashboard - Quick Start Guide

## 🚀 Getting Started

### Step 1: Access the Dashboard
1. Log in to your account using `jedi21132@gmail.com`
2. Click on your profile icon in the top-right navbar
3. Click "Analytics" in the dropdown menu
4. The dashboard will load automatically

### Step 2: Dashboard Overview

You'll see five main visualizations:

#### 📈 Member Growth Chart (Top)
- Shows cumulative member count from February 2024
- **Tabs at top:** All Time | 2024 | 2025 | 2026
- **Button:** "Add Event Marker" to mark important dates (trailer releases, milestones, etc.)
- Hover over points to see exact member counts

#### 📊 Event Attendance (Left Side)
- Bar chart showing event attendance over the last 30 days
- Includes forum activities with attendee counts
- Hover to see event details

#### 📉 Month-over-Month Growth (Right Side)
- Shows how many new members joined each month
- Green bars = growth, Red bars = decline
- Useful for tracking growth trends

#### 💰 Finance Section (Middle)
- **Left:** Monthly site upkeep costs (line chart)
- **Right:** Founder contributions list
- Shows who's contributing how much to monthly budget

#### 🎉 Events Hosted (Bottom)
- Bar chart showing events hosted in the last 12 months
- Organized by month
- Hover to see event count details

### Step 3: Summary Statistics (Top Cards)
- **Total Members:** Current count with monthly change
- **Events This Month:** Count vs last month
- **MoM Growth:** Growth rate percentage
- **Monthly Budget:** Total spending

---

## 📍 Adding Event Markers

Event markers highlight important dates on your Member Growth timeline.

### How to Add a Marker:
1. Scroll to the Member Growth chart
2. Click "**Add Event Marker**" button
3. Fill in the form:
   - **Date:** When did this happen? (e.g., 2024-07-15)
   - **Event Title:** What happened? (e.g., "Trailer Release")
   - **Description:** Optional details (e.g., "Official YouTube trailer launched")
4. Click "**Add Marker**"
5. The chart updates instantly with your new marker

### Example Markers:
- "Trailer Release" - when promotional trailer launched
- "Major Update" - significant feature additions
- "Anniversary" - project milestones
- "Community Event" - special events or celebrations

---

## 💰 Managing Finance Data

### Access the Finance Editor
1. Go to `/admin/analytics/` directly, OR
2. From the analytics dashboard, look for finance edit option (future enhancement)

### What You Can Manage:

#### Monthly Site Upkeep Costs
1. Each row = one month
2. Enter month abbreviation (Jan, Feb, Mar, etc.)
3. Enter monthly cost in dollars
4. Click the trash icon to remove a month
5. Click "Add Month" to add a new one

#### Founder Contributions
1. Each row = one founder
2. Enter founder name
3. Enter their monthly contribution amount
4. Click trash icon to remove
5. Click "Add Founder" to add another

#### Budget Settings
1. **Total Monthly Budget:** Sum of all monthly spending
2. **Finance Notes:** Any additional context or notes

### Saving Your Changes
1. Make all edits
2. Click "**Save All Changes**" button at the bottom
3. Wait for success message
4. Changes appear on analytics dashboard

---

## 🎨 Dashboard Features

### Filter by Year
Click the year tabs on the Member Growth chart:
- **All Time** - From Feb 2024 to now
- **2024** - 2024 data only
- **2025** - 2025 data only
- **2026** - 2026 data only

### Hover Information
Hover over any chart to see:
- Exact values
- Dates and times
- Additional details

### Responsive Design
- Works on desktop, tablet, and mobile
- Charts adjust to screen size
- All buttons are touch-friendly

### Dark/Light Mode
- Dashboard matches your theme preference
- Click profile icon → toggle theme

---

## 📊 Understanding the Charts

### Member Growth (Line Chart)
- **What it shows:** How your community grows over time
- **Y-axis:** Total number of members
- **X-axis:** Time (months)
- **Use it to:** Track community size, spot trends, identify growth periods

### Event Attendance (Bar Chart)
- **What it shows:** Who attended events in the last month
- **Y-axis:** Number of attendees
- **X-axis:** Dates
- **Use it to:** See which events are popular, engagement levels

### Month-over-Month Growth (Bar Chart)
- **What it shows:** New members added each month
- **Y-axis:** New members count
- **X-axis:** Months
- **Use it to:** Track acceleration/deceleration of growth

### Site Upkeep (Line Chart)
- **What it shows:** Monthly operational costs
- **Y-axis:** Cost in dollars
- **X-axis:** Months
- **Use it to:** Budget planning, identify cost trends

### Events Hosted (Bar Chart)
- **What it shows:** Event hosting activity
- **Y-axis:** Number of events
- **X-axis:** Months (last 12)
- **Use it to:** Track community activity levels

---

## ❓ Frequently Asked Questions

### Q: Why can't I see some data?
A: Data comes from actual activities:
- Members from created characters
- Events from forum threads
- Finance from admin settings

If charts are empty, there might not be data yet.

### Q: How often does data update?
A: Data refreshes when you reload the page. We read live data from Firestore.

### Q: Can I export this data?
A: Currently no, but this is planned for future versions.

### Q: What if I make a mistake in finance data?
A: Just edit it again and click "Save All Changes". Previous data is overwritten.

### Q: Who else can see this dashboard?
A: Only `jedi21132@gmail.com`. All finance data is only editable by you.

### Q: Can I add other admins?
A: Currently only one admin email. Contact support if you need multiple admins.

---

## 🔗 Quick Links

- **Main Dashboard:** `/analytics/`
- **Finance Editor:** `/admin/analytics/`
- **Full Documentation:** `/ANALYTICS_GUIDE.md`
- **Implementation Details:** `/ANALYTICS_IMPLEMENTATION.md`

---

## 🆘 Troubleshooting

### Dashboard Blank?
- Make sure you're logged in as `jedi21132@gmail.com`
- Check your internet connection
- Clear browser cache (Ctrl+Shift+Delete)
- Try a different browser

### Charts Not Showing?
- Wait a moment for charts to load
- Check browser console (F12) for errors
- Reload the page
- Verify Firestore has data

### Changes Not Saving?
- Check your internet connection
- Make sure you clicked "Save All Changes"
- Look for error messages
- Check Firestore console for rule violations

### Analytics Link Not Showing?
- Log out and log back in
- Make sure you're using `jedi21132@gmail.com`
- Try a different browser
- Clear cookies/cache

---

## 💡 Tips & Tricks

1. **Bookmark it:** Add `/analytics/` to your bookmarks for quick access
2. **Use the tabs:** Switch between years on Member Growth chart
3. **Hover for details:** Charts have tooltips with exact info
4. **Save regularly:** Don't leave unsaved finance data
5. **Monitor trends:** Check regularly for growth patterns
6. **Document markers:** Always add descriptions to event markers

---

## 📞 Support

For technical issues or feature requests:
- Check the full documentation: `ANALYTICS_GUIDE.md`
- Review implementation details: `ANALYTICS_IMPLEMENTATION.md`
- Contact: `jedi21132@gmail.com`

---

**Last Updated:** January 2026
**Dashboard Version:** 1.0
**Status:** ✅ Ready to Use
