# Player Management System Implementation Plan

> **Note (2026-10-31):** `statistics-advanced`, `statistics-summary-get`, `statistics-season-get`, `statistics-player-get` and `statistics-season-players-bulk` were removed (unused). The page now loads everything from `statistics-all`; the Advanced, Duties and Financial tabs are calculated in `netlify/functions/_advanced-stats.ts`.

## Overview
Implement a comprehensive player management system for Bengals Cricket Club that enables admins to manage player pool, track team assignments, monitor availability for fixtures, and generate statistics at both team and club levels.

## Current State Analysis

### Existing Infrastructure
**Admin System** (Already Implemented):
- Authentication: JWT-based sessions with Netlify Blobs storage
- Admin pages: `/admin` (submissions), `/admin/users` (user management)
- AdminLayout with sidebar navigation
- Netlify Functions for CRUD operations
- PapaParse v5.5.3 for CSV parsing

**Teams** (Hardcoded in `/src/pages/teams.astro`):
- **Bengal Tigers** - White Ball Division 2 (WB-D2), Captain: Likith Gowda
- **Bengal Bulls** - White Ball Division 3 (WB-D3), Captain: Mazar Khan
- **Bengal Thunder Cats** - Pink Ball Division 1 (PB-D1), Captain: Sharan CK

**Fixtures** (CSV format):
- Location: `/src/data/fixtures.csv`
- 37 matches from November 2025 to March 2026
- Parsed with PapaParse in `/src/pages/fixtures.astro`

**Current Gap**:
- No season management system
- No player data management system (global pool)
- No core roster management (marking players as core to teams)
- No availability tracking for matches (admin-managed)
- No statistics calculation (multi-season)
- No fixture upload/management per season (currently using single CSV)

## User Requirements

1. **Season Management**
   - Create and manage cricket seasons (e.g., "2025-2026")
   - Track which season is currently active
   - Define teams for each season with flexible formats (T20, T30, T40, etc.)
   - Teams and formats can change between seasons

2. **Player Pool Management (Global)**
   - Bulk import players from Excel/CSV
   - Add/edit/delete individual players
   - Track simple player details: First Name, Last Name, Role, Email, USAC ID, Active Status
   - Players are NOT tied to specific seasons
   - Players exist in a global pool

3. **Team Roster Management (Core Status)**
   - Mark players as "core" to specific teams
   - Players can be core to multiple teams (e.g., different formats)
   - Admin can mark/unmark core status anytime during a season
   - Display core roster per team with historical tracking
   - View which players were core to which teams in previous seasons

4. **Availability Tracking (Admin-Managed)**
   - **Admin marks** which players were available for each fixture
   - **Admin marks** which players were selected/played in the game
   - Two-step tracking: Availability → Selection
   - Link availability data to specific fixtures
   - Add notes per player per fixture

5. **Statistics Dashboard**
   - Games played per player (team level + club level + career)
   - Availability rates per season and career
   - Selection rates (how often available players get selected)
   - Team-level and season-level summaries
   - Historical comparisons across seasons

6. **Bulk Operations**
   - CSV/Excel import with validation
   - Bulk delete players
   - Export player data and statistics per season

---

## Data Models

### Season Schema
```typescript
interface Season {
  id: string;                    // UUID
  name: string;                  // "2025-2026"
  startDate: string;             // ISO date
  endDate: string;               // ISO date
  isActive: boolean;             // Only one season active at a time
  teams: TeamDefinition[];       // Teams for this season (flexible, can change)
  createdAt: string;
  createdBy: string;
}

interface TeamDefinition {
  teamName: string;              // Team name (flexible per season)
  division: string;              // "WB-D2", "WB-D3", "PB-D1", etc.
  captain?: string;              // Player ID
  viceCaptain?: string;          // Player ID
}
```

### Fixture Schema
```typescript
interface Fixture {
  id: string;                    // UUID
  seasonId: string;
  gameNumber: string;            // "Game 1", "Game 2", etc.
  date: string;                  // ISO date
  time: string;
  team: string;                  // Team name from season
  opponent: string;
  venue: string;
  division: string;
  createdAt: string;
  createdBy: string;
}
```

### Player Schema (Simplified)
```typescript
interface Player {
  id: string;                    // UUID
  firstName: string;
  lastName: string;
  email: string;
  usacId: string;                // USAC ID
  role: string;                  // Batsman, Bowler, All-rounder, Wicket-keeper
  isActive: boolean;             // Currently active in club
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}
```

### Core Roster Schema (Team Assignments)
```typescript
interface CoreRosterAssignment {
  id: string;                    // UUID
  playerId: string;
  playerName: string;            // Cached for display
  teamName: string;              // Team name
  seasonId: string;
  seasonName: string;            // Cached for display
  isCore: boolean;               // Is this player core to this team?
  markedCoreDate?: string;       // When marked as core
  unmarkedCoreDate?: string;     // When unmarked (if no longer core)
  createdAt: string;
  updatedAt: string;
  updatedBy: string;             // Admin who last updated
}
```

### Availability Schema (Admin-Managed)
```typescript
interface FixtureAvailability {
  id: string;
  fixtureId: string;             // Maps to Game# from fixtures.csv
  seasonId: string;
  gameNumber: string;
  date: string;
  team: string;
  opponent: string;
  venue: string;
  playerAvailability: PlayerAvailabilityRecord[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;             // Admin username who last updated
}

interface PlayerAvailabilityRecord {
  playerId: string;
  playerName: string;
  wasAvailable: boolean;         // Admin marks: Was player available?
  wasSelected: boolean;          // Admin marks: Was player selected/played?
  notes?: string;                // Optional notes
  lastUpdated: string;
}
```

### Statistics Schema (Multi-Season)
```typescript
interface PlayerStatistics {
  playerId: string;
  playerName: string;
  seasonStats: {
    [seasonId: string]: {
      seasonName: string;
      teamStats: {
        [teamName: string]: {
          totalFixtures: number;       // Total fixtures for team in season
          timesAvailable: number;      // Times marked available
          gamesPlayed: number;         // Times marked selected
          availabilityRate: number;    // (timesAvailable / totalFixtures) * 100
          selectionRate: number;       // (gamesPlayed / timesAvailable) * 100
        };
      };
      clubStats: {
        totalFixtures: number;
        timesAvailable: number;
        gamesPlayed: number;
        availabilityRate: number;
        selectionRate: number;
      };
    };
  };
  careerStats: {
    totalSeasons: number;
    totalFixtures: number;
    totalGamesPlayed: number;
    careerAvailabilityRate: number;
    careerSelectionRate: number;
  };
  lastUpdated: string;
}
```

---

## Storage Strategy

### Netlify Blobs Stores
```
Store: "seasons"
  - Key: "seasons-list" → Season[]
  - Key: "active-season" → Season (current active season)

Store: "fixtures"
  - Key: "fixtures-{seasonId}" → Fixture[] (fixtures for specific season)

Store: "players"
  - Key: "players-all" → Player[] (global player pool)

Store: "core-roster"
  - Key: "core-roster-{seasonId}" → CoreRosterAssignment[] (all core assignments for season)
  - Key: "core-roster-{seasonId}-{teamName}" → CoreRosterAssignment[] (core players for specific team)

Store: "fixture-availability"
  - Key: "availability-{fixtureId}" → FixtureAvailability
  - Key: "availability-index-{seasonId}" → { fixtureId, gameNumber, date, team }[]

Store: "player-statistics"
  - Key: "player-stats-{playerId}" → PlayerStatistics (includes all seasons)
  - Key: "team-stats-{teamName}-{seasonId}" → TeamStatisticsSummary
  - Key: "season-stats-{seasonId}" → SeasonStatisticsSummary
```

### CSV Import/Export Format
**players-import.csv** (Global Player Pool)
```csv
First Name,Last Name,Email,USAC ID,Role,Status
John,Doe,john@example.com,USAC12345,Batsman,Active
Jane,Smith,jane@example.com,USAC67890,All-rounder,Active
```

**Validation Rules:**
- Required: First Name, Last Name, Email, USAC ID, Role
- Email must be unique within club
- USAC ID must be unique
- Role: Batsman, Bowler, All-rounder, Wicket-keeper
- Status: Active, Inactive (defaults to Active)

---

## File Structure

```
src/
├── pages/admin/
│   ├── seasons.astro              # Season management (list, create, set active)
│   ├── fixtures.astro             # Fixture management per season (list, upload CSV, add/edit)
│   ├── players.astro              # Player management (global pool - list, add, edit, delete)
│   ├── players/
│   │   └── import.astro           # CSV import wizard (global)
│   ├── roster.astro               # Team roster management (mark/unmark core status)
│   ├── availability.astro         # Availability tracking per fixture (admin-managed)
│   └── statistics.astro           # Statistics dashboard (multi-season)
├── types/
│   └── player.ts                  # Season, Fixture, Player, CoreRosterAssignment, FixtureAvailability, Statistics
└── layouts/
    └── AdminLayout.astro          # UPDATE: Add all management links

netlify/functions/
├── seasons-list.ts                # GET: List all seasons
├── seasons-create.ts              # POST: Create new season
├── seasons-update.ts              # PUT: Update season (set active, edit dates)
├── seasons-get-active.ts          # GET: Get currently active season
├── fixtures-list.ts               # GET: List fixtures for season
├── fixtures-create.ts             # POST: Create single fixture
├── fixtures-import.ts             # POST: Bulk import fixtures from CSV (per season)
├── fixtures-update.ts             # PUT: Update fixture details
├── fixtures-delete.ts             # DELETE: Delete fixture(s)
├── fixtures-export.ts             # GET: Export fixtures to CSV (per season)
├── players-list.ts                # GET: List all players (global pool)
├── players-get.ts                 # GET: Get single player by ID
├── players-create.ts              # POST: Create new player (global)
├── players-update.ts              # PUT: Update player details
├── players-delete.ts              # DELETE: Delete player (soft delete)
├── players-import.ts              # POST: Bulk import from CSV (global)
├── players-export.ts              # GET: Export players to CSV (global)
├── core-roster-list.ts            # GET: List core roster (filtered by season/team)
├── core-roster-update.ts          # POST: Mark/unmark player as core to team
├── core-roster-bulk-update.ts     # POST: Bulk update core status for multiple players
├── availability-create.ts         # POST: Create availability record for fixture
├── availability-get.ts            # GET: Get availability by fixture ID
├── availability-list.ts           # GET: List availability records (filtered by season/team)
├── availability-update.ts         # POST: Admin updates player availability & selection
├── statistics-calculate.ts        # POST: Recalculate statistics (for season or player)
├── statistics-player-get.ts       # GET: Get player statistics (all seasons + career)
├── statistics-team-get.ts         # GET: Get team statistics (specific season)
├── statistics-season-get.ts       # GET: Get season statistics (all teams)
└── statistics-export.ts           # GET: Export statistics to CSV

docs/
└── guides/
    └── PLAYER_MANAGEMENT_GUIDE.md # Admin user guide (NEW)
```

---

## Implementation Plan

### Phase 1: Foundation (Season Management & Data Models)

**Step 1.1: Create Data Models**
- File: `/src/types/player.ts`
- Define: Season, TeamDefinition, Fixture, Player, CoreRosterAssignment, FixtureAvailability, PlayerAvailabilityRecord, PlayerStatistics
- Export all interfaces

**Step 1.2: Implement Season Management Functions**
Create Netlify functions for season management:

1. **seasons-list.ts**
   - GET: Returns all seasons (sorted by date, active first)
   - Returns: Season[]

2. **seasons-create.ts**
   - POST with body: `{ name, startDate, endDate, teams }`
   - Validate: Date range, team definitions
   - Generate UUID, set isActive to false initially
   - Returns: Created season

3. **seasons-update.ts**
   - PUT with body: `Partial<Season> & { id: string }`
   - Special handling: Setting isActive=true deactivates other seasons
   - Returns: Updated season

4. **seasons-get-active.ts**
   - GET: Returns currently active season
   - Returns: Season or null

**Step 1.3: Create Season Management Page**
- File: `/src/pages/admin/seasons.astro`
- Features:
  - List all seasons (active season highlighted)
  - Create new season button → Modal form
  - Set Active button per season
  - Edit season details
  - View teams configured for season

**Season Form Modal:**
- Season Name* (e.g., "2025-2026")
- Start Date*, End Date*
- Team Configuration:
  - For each team: Name, Division, Captain (dropdown of players), Vice Captain
  - Use existing 3 teams as default

**Step 1.4: Implement Player CRUD Functions**
Create Netlify functions following existing patterns from `admin-users-*`:

1. **players-list.ts**
   - GET with query params: `?status=active&search=john&role=Batsman`
   - Returns all players from global pool (filtered by status, search query, role)
   - Returns: Player[]
   - Pattern: Load from Blobs, filter in memory

2. **players-get.ts**
   - GET with query: `?id=player-123`
   - Returns: Single Player object

3. **players-create.ts**
   - POST with body: `Omit<Player, 'id' | 'createdAt' | 'updatedAt'>`
   - Validate: email uniqueness, USAC ID uniqueness
   - Generate UUID, timestamps
   - Returns: Created player

4. **players-update.ts**
   - PUT with body: `Partial<Player> & { id: string }`
   - Update player details
   - Returns: Updated player

5. **players-delete.ts**
   - DELETE with body: `{ id: string } | { ids: string[] }`
   - Soft delete: Mark player as inactive
   - Support bulk delete
   - Returns: `{ success: true, deletedCount: number }`

**Step 1.5: Create Player Management Page**
- File: `/src/pages/admin/players.astro`
- Features:
  - Stats cards: Total Players, Active Players, Inactive Players
  - Search bar (name, email, USAC ID)
  - Filter dropdowns (status, role)
  - Table columns: Checkbox, Name, Email, USAC ID, Role, Status, Actions
  - Bulk actions toolbar: Delete Selected, Export
  - Add Player button → Modal form
  - Import Players button → Link to import wizard
  - Edit/Delete actions per row

**Player Form Modal:**
- First Name*, Last Name*, Email*
- USAC ID*
- Role dropdown* (Batsman, Bowler, All-rounder, Wicket-keeper)
- Status toggle (Active/Inactive in club)

**Step 1.6: Implement Core Roster Management Functions**
Create Netlify functions for managing core status:

1. **core-roster-list.ts**
   - GET with query: `?seasonId=xxx&teamName=Bengal Tigers`
   - Returns: CoreRosterAssignment[] (filtered by season/team)
   - If no filters, return all for active season

2. **core-roster-update.ts**
   - POST with body: `{ playerId, teamName, seasonId, isCore: boolean }`
   - Mark or unmark player as core to a team for a season
   - Creates or updates CoreRosterAssignment record
   - Returns: Updated CoreRosterAssignment

3. **core-roster-bulk-update.ts**
   - POST with body: `{ seasonId, teamName, updates: [{ playerId, isCore }] }`
   - Bulk update core status for multiple players
   - Returns: `{ success: true, updatedCount: number }`

**Step 1.7: Create Team Roster Management Page**
- File: `/src/pages/admin/roster.astro`
- Features:
  - **Season selector** dropdown at top (defaults to active season)
  - **Team selector** dropdown (Bengal Tigers, Bengal Bulls, Bengal Thunder Cats)
  - Stats cards: Total Core Players, Total Players Available
  - Two-column layout:
    - Left: **Core Players** (players marked as core for selected team)
    - Right: **Available Players** (all other active players)
  - Drag-and-drop or buttons to mark/unmark core status
  - Search bar to filter players
  - "Mark as Core" / "Remove from Core" buttons
  - Save changes button

**Roster Management UI:**
- Display all active players
- Checkbox or toggle to mark player as core
- Visual indicator (badge/highlight) for core players
- Quick actions: "Mark All", "Clear All"
- Show which other teams a player is core to (if any)

**Step 1.8: Implement Fixture Management Functions**
Create Netlify functions for fixture management per season:

1. **fixtures-list.ts**
   - GET with query: `?seasonId=xxx`
   - Returns: Fixture[] for that season

2. **fixtures-create.ts**
   - POST with body: `Omit<Fixture, 'id' | 'createdAt'> & { seasonId }`
   - Validate: team name matches season teams
   - Returns: Created fixture

3. **fixtures-import.ts**
   - POST with form data: CSV file + seasonId
   - Parse CSV using PapaParse
   - Validate all rows (date, team names, required fields)
   - Bulk create fixtures
   - Returns: `{ created: N, errors: [...] }`

4. **fixtures-update.ts**
   - PUT with body: `Partial<Fixture> & { id: string }`
   - Returns: Updated fixture

5. **fixtures-delete.ts**
   - DELETE with body: `{ id: string } | { ids: string[] }`
   - Returns: `{ success: true, deletedCount: number }`

6. **fixtures-export.ts**
   - GET with query: `?seasonId=xxx`
   - Generate CSV
   - Returns: CSV file

**Step 1.9: Create Fixture Management Page**
- File: `/src/pages/admin/fixtures.astro`
- Features:
  - **Season selector** dropdown (defaults to active season)
  - Stats cards: Total Fixtures, Upcoming, Completed
  - Import Fixtures button → Upload CSV modal
  - Add Fixture button → Manual entry form
  - Fixtures table: Game #, Date, Team, Opponent, Venue, Division, Actions
  - Edit/Delete per fixture
  - Export to CSV button

**Fixture Import/Upload:**
- Upload CSV for selected season
- Preview table with validation errors
- CSV format:
  ```csv
  Game Number,Date,Time,Team,Opponent,Venue,Division
  Game 1,2025-11-10,10:00 AM,Bengal Tigers,Team A,Venue 1,WB-D2
  ```

**Step 1.10: Update AdminLayout Navigation**
- File: `/src/layouts/AdminLayout.astro`
- Add links:
  - Season Management
  - Fixture Management
  - Player Management
  - Team Roster Management (NEW - mark/unmark core status)
  - Availability Tracking
  - Statistics
- Use appropriate icons and existing nav pattern

### Phase 2: Import/Export System

**Step 2.1: Implement Import Function**
- File: `/netlify/functions/players-import.ts`
- Parse CSV using PapaParse (already installed)
- Validation logic:
  - Check required fields (First Name, Last Name, Email, USAC ID, Role)
  - Validate email format and uniqueness
  - Validate USAC ID uniqueness
  - Validate role against allowed values
- Mode support: 'create' | 'update' | 'upsert'
- Returns: `{ created: N, updated: M, errors: [...] }`

**Step 2.2: Implement Export Function**
- File: `/netlify/functions/players-export.ts`
- Generate CSV from player data
- Content-Type: text/csv
- Download filename: `players-export-YYYY-MM-DD.csv`

**Step 2.3: Create Import Wizard**
- File: `/src/pages/admin/players/import.astro`
- Multi-step process:
  1. **Upload**: Drag-drop zone, download template link
  2. **Validation**: Show preview table with errors highlighted
  3. **Confirmation**: Summary (X new, Y updates, Z errors)
  4. **Results**: Success/error report, link to player list

**Step 2.4: Add Bulk Operations**
- Bulk delete with confirmation
- Bulk status change (activate/deactivate)
- Export selected players to CSV

### Phase 3: Availability Tracking (Admin-Managed)

**Step 3.1: Implement Availability Functions**

1. **availability-create.ts**
   - POST: `{ fixtureId, gameNumber, team, seasonId }`
   - Auto-populate players who are marked as core to this team in this season
   - Initialize all records: wasAvailable=false, wasSelected=false
   - Returns: FixtureAvailability

2. **availability-get.ts**
   - GET: `?fixtureId=123`
   - Returns: Full FixtureAvailability with all player records

3. **availability-list.ts**
   - GET: `?seasonId=xxx&team=Bengal Tigers&dateFrom=2025-11-01`
   - Returns: Availability summaries (with stats: X available, Y selected)

4. **availability-update.ts**
   - POST: `{ fixtureId, updates: [{ playerId, wasAvailable, wasSelected, notes }] }`
   - Admin batch updates player availability and selection
   - Validation: wasSelected can only be true if wasAvailable is true
   - Timestamp updates, record admin username
   - Returns: Updated FixtureAvailability

**Step 3.2: Create Availability Page**
- File: `/src/pages/admin/availability.astro`
- Features:
  - **Season selector** dropdown (defaults to active season)
  - Fixture list (upcoming first, past fixtures below)
  - Filters: team, date range, status (pending/completed)
  - Click fixture → Show availability editor

  **Availability Editor (Two-Column Grid):**
  - Player list from core roster (players marked as core to this team)
  - Column 1: "Was Available?" checkbox
  - Column 2: "Was Selected?" checkbox (enabled only if available=true)
  - Notes field per player
  - Quick actions:
    - "Mark All Available" button
    - "Mark All Unavailable" button
  - Save button

  **Stats Display:**
  - Total players in team: X
  - Marked available: Y
  - Selected to play: Z
  - Availability rate: Y/X
  - Selection rate: Z/Y

**Step 3.3: Integrate with Fixtures**
- Add "Manage Availability" button on fixtures page (admin only)
- Link to availability editor for that fixture
- Show availability status badge on fixture cards (e.g., "5/11 available, 3 selected")

### Phase 4: Statistics System (Multi-Season)

**Step 4.1: Implement Statistics Functions**

1. **statistics-calculate.ts**
   - POST: `{ seasonId?, playerId? }` - Optional: recalculate specific season or player
   - Load players, availability records, fixtures
   - Calculate per-player stats (team + season + career levels)
   - Calculate team summaries per season
   - Save to Blobs
   - Returns: `{ success: true, playersUpdated: N, seasonsUpdated: M }`

2. **statistics-player-get.ts**
   - GET: `?playerId=123`
   - Returns: PlayerStatistics (all seasons + career totals)

3. **statistics-team-get.ts**
   - GET: `?teamName=Bengal Tigers&seasonId=xxx`
   - Returns: TeamStatisticsSummary for specific season

4. **statistics-season-get.ts**
   - GET: `?seasonId=xxx`
   - Returns: SeasonStatisticsSummary (all teams aggregated)

5. **statistics-export.ts**
   - GET: `?seasonId=xxx&format=csv`
   - Export statistics to CSV (for specific season or career)

**Statistics Calculation Logic:**
```typescript
For each player:
  Find all CoreRosterAssignments where player was marked as core

  For each season where player was core to at least one team:
    For each team player was core to in that season:
      - Count total fixtures for that team in season
      - Count times marked wasAvailable = true (from FixtureAvailability)
      - Count times marked wasSelected = true (from FixtureAvailability)
      - Calculate availability rate = (timesAvailable / totalFixtures) * 100
      - Calculate selection rate = (gamesPlayed / timesAvailable) * 100

    Season club level:
      - Aggregate across all teams player was core to in season
      - Total fixtures (deduplicated by fixture ID)
      - Total times available
      - Total games played
      - Season availability rate
      - Season selection rate

  Career level:
    - Aggregate across all seasons
    - Total seasons participated in
    - Total fixtures (across all teams, all seasons)
    - Total games played
    - Career availability rate = (total available / total fixtures) * 100
    - Career selection rate = (total played / total available) * 100
```

**Step 4.2: Create Statistics Dashboard**
- File: `/src/pages/admin/statistics.astro`
- Features:
  - **Season selector** dropdown (or "All Seasons" for career view)
  - **Team selector** dropdown (or "All Teams")
  - View Mode toggle: Season | Career

  **Season View Stats Cards:**
  - Total Players This Season
  - Average Availability Rate
  - Average Selection Rate
  - Total Fixtures This Season
  - High Availability Players (>80%)
  - Low Availability Players (<50%)

  **Career View Stats Cards:**
  - Total Players (All Time)
  - Average Career Availability
  - Average Career Selection Rate
  - Total Seasons
  - Most Consistent Player (highest career availability)

  **Player Statistics Table (Sortable):**
  - Player Name
  - Team(s)
  - Fixtures (Total for season/career)
  - Available (Count + %)
  - Played (Count + %)
  - Selection Rate (%)

  **Actions:**
  - Export to CSV button
  - Recalculate Statistics button
  - Compare Seasons button (future enhancement)

**Step 4.3: Add Stats to Player Page**
- Show mini stats card in player detail modal:
  - Current season: X fixtures, Y played
  - Career: Z total games
- "View Full Statistics" link → Opens statistics dashboard filtered to this player

### Phase 5: Polish & Testing

**Step 5.1: UI/UX Improvements**
- Loading states (spinners, skeleton loaders)
- Toast notifications for actions
- Empty states with helpful messages
- Mobile responsive design
- Keyboard shortcuts (optional)

**Step 5.2: Validation & Error Handling**
- Client-side validation with helpful messages
- Server-side validation in all functions
- Graceful error handling with user-friendly messages
- Prevent duplicate emails
- Prevent duplicate USAC IDs
- Validate role values

**Step 5.3: Documentation**
- Create `/docs/guides/PLAYER_MANAGEMENT_GUIDE.md`
- Include CSV import template
- Document availability tracking workflow
- Admin screenshots and instructions

---

## UI Patterns & Styling

### Reuse Existing Patterns

**From `/admin/index.astro`:**
- Table structure with checkboxes
- Bulk actions toolbar
- Search input with icon
- Modal overlays
- Loading/error/empty states
- Stats cards grid
- Page header with blue gradient (white text)

**From `/admin/users.astro`:**
- Form layouts
- Alert messages (success/error)
- Add/create forms in cards

### Team Color Coding
```typescript
const teamColors = {
  'Bengal Tigers': 'bg-orange-100 border-orange-300 text-orange-800',
  'Bengal Bulls': 'bg-blue-100 border-blue-300 text-blue-800',
  'Bengal Thunder Cats': 'bg-purple-100 border-purple-300 text-purple-800'
};
```

### Availability Status Colors
```typescript
const availabilityColors = {
  available: 'bg-green-100 text-green-800 border-green-300',
  notAvailable: 'bg-gray-100 text-gray-600 border-gray-300',
  selected: 'bg-blue-100 text-blue-800 border-blue-300' // Played in game
};
```

### Season Badge Styling
```typescript
const seasonBadgeColors = {
  active: 'bg-green-500 text-white',
  inactive: 'bg-gray-300 text-gray-700'
};
```

---

## Data Flow Diagrams

### Season Creation Flow
```
Admin → Create Season Form → Fill Details (Name, Dates, Teams)
  ↓
POST /api/seasons-create
  ↓
Function:
  - Validate session
  - Validate date range
  - Generate UUID
  - Load seasons from Blobs
  - Append new season (isActive=false)
  - Save to Blobs
  ↓
UI Update → Success Message
  ↓
Admin can then "Set Active" to activate season
```

### Player Creation Flow (Global Pool)
```
Admin → Fill Form → Validate
  ↓
POST /api/players-create
  ↓
Function:
  - Validate session
  - Validate data (email unique, USAC ID unique, role valid)
  - Generate UUID
  - Load players from Blobs
  - Append new player to global pool
  - Save to Blobs (players-all)
  ↓
UI Update → Success Message
  ↓
Admin can then mark player as core to teams via Roster Management page
```

### Core Roster Assignment Flow
```
Admin → Navigate to Roster Management → Select Season & Team
  ↓
Load Core Roster for Team
  ↓
Display:
  - Left: Core Players (marked as core)
  - Right: Available Players (all other active players)
  ↓
Admin marks/unmarks players as core
  ↓
POST /api/core-roster-update (or bulk-update)
  ↓
Function:
  - Validate session
  - Load CoreRosterAssignment for season/team
  - Update isCore status for specified players
  - Set markedCoreDate or unmarkedCoreDate
  - Save to Blobs
  ↓
UI Update → Success Message
```

### Availability Update Flow (Admin-Managed)
```
Admin → Select Fixture → Load Availability Editor
  ↓
GET /api/availability-get?fixtureId=X
  ↓
Display Team Players in Grid:
  - Column 1: "Was Available?" checkboxes
  - Column 2: "Was Selected?" checkboxes (enabled only if available)
  ↓
Admin marks availability and selection for each player
  ↓
POST /api/availability-update
  ↓
Function:
  - Validate session
  - Load FixtureAvailability from Blobs
  - Validate: wasSelected requires wasAvailable=true
  - Update PlayerAvailabilityRecord[] with timestamps
  - Record admin username in updatedBy
  - Save to Blobs
  ↓
UI Update → Success Message
  ↓
Stats recalculate (triggered manually or automatically)
```

### CSV Import Flow
```
Admin → Upload CSV → Parse (PapaParse)
  ↓
Validate Rows:
  - Required fields (First Name, Last Name, Email, USAC ID, Role)
  - Email format and uniqueness
  - USAC ID uniqueness
  - Role valid
  ↓
Show Preview (errors highlighted)
  ↓
Admin Confirms
  ↓
POST /api/players-import
  ↓
Function:
  - Validate session
  - Load existing players
  - For each row: create or update
  - Batch save to Blobs (players-all)
  ↓
Return Summary (X created, Y updated, Z errors)
  ↓
Show Results Page
```

---

## Security Considerations

### Authentication
- All functions validate admin session using existing `validateAdminSession()`
- Reuse JWT + cookie pattern
- No public access to player management

### Data Validation
- Email format validation and uniqueness
- USAC ID uniqueness
- Sanitize all inputs
- Role validation (Batsman, Bowler, All-rounder, Wicket-keeper)
- Team name validation against existing teams

### Access Control
- Admin-only access
- Audit trail: createdBy, updatedBy fields
- Consider soft delete (mark inactive instead of hard delete)

### Privacy
- Don't expose player emails publicly
- USAC IDs kept secure (admin-only access)
- Secure export functionality (admin-only)

### Rate Limiting
- CSV import: Max 1000 rows
- Bulk delete: Max 100 players at once

---

## Testing Strategy

### Manual Testing Checklist

**Season Management:**
- [ ] Create new season
- [ ] Edit season details
- [ ] Set season as active (deactivates others)
- [ ] View all seasons
- [ ] Configure teams for season
- [ ] Validate date ranges

**Player Management (Global Pool):**
- [ ] Add new player to global pool
- [ ] Edit existing player details
- [ ] Delete single player (soft delete)
- [ ] Bulk delete players
- [ ] Search players (name, email, USAC ID)
- [ ] Filter by status, role
- [ ] Validate email uniqueness
- [ ] Validate USAC ID uniqueness
- [ ] Validate role selection
- [ ] Active/inactive toggle
- [ ] View all players in global pool

**Team Roster Management (Core Status):**
- [ ] Select season and team
- [ ] View current core players for team
- [ ] View all available players
- [ ] Mark player as core to team
- [ ] Unmark player from core roster
- [ ] Mark player as core to multiple teams
- [ ] Save core roster changes
- [ ] View which teams a player is core to
- [ ] View historical core rosters (previous seasons)
- [ ] Bulk mark/unmark operations

**Import/Export:**
- [ ] Download import template
- [ ] Import valid CSV to global pool
- [ ] Import CSV with errors (validate preview)
- [ ] Export players to CSV (global pool)
- [ ] Handle duplicate emails
- [ ] Handle duplicate USAC IDs
- [ ] Validate role values

**Availability (Admin-Managed):**
- [ ] Create availability record for fixture
- [ ] View player list for team (from core roster)
- [ ] Mark players as available
- [ ] Mark available players as selected
- [ ] Verify cannot select unavailable players
- [ ] Add notes to player records
- [ ] View availability statistics (X available, Y selected)
- [ ] Filter fixtures by season/team/date
- [ ] Save and persist changes
- [ ] Verify only core players shown for each fixture

**Statistics:**
- [ ] View player statistics (single season)
- [ ] View player career statistics (all seasons)
- [ ] View team statistics (specific season)
- [ ] View season statistics (all teams)
- [ ] Sort by availability rate
- [ ] Sort by selection rate
- [ ] Switch between season and career views
- [ ] Export statistics to CSV
- [ ] Recalculate statistics
- [ ] Verify calculations (spot check)
- [ ] Verify career aggregations correct

**Error Handling:**
- [ ] Session expired
- [ ] Network error
- [ ] Invalid data submission
- [ ] Missing required fields
- [ ] Blob storage failure
- [ ] Invalid season selection
- [ ] Attempting to select unavailable player

---

## Critical Files

### To Create (Priority Order)

1. **`/src/types/player.ts`**
   - All TypeScript interfaces (Season, Fixture, Player, CoreRosterAssignment, FixtureAvailability, Statistics)
   - Foundation for entire system

2. **`/netlify/functions/seasons-list.ts`**
   - List all seasons
   - Required first to set up seasons

3. **`/netlify/functions/seasons-create.ts`**
   - Create new seasons
   - Core setup function

4. **`/src/pages/admin/seasons.astro`**
   - Season management UI
   - Must be created before fixture/player management

5. **`/netlify/functions/fixtures-list.ts`**
   - List fixtures for season
   - Required before availability tracking

6. **`/netlify/functions/fixtures-import.ts`**
   - Bulk import fixtures from CSV (per season)
   - CSV parsing with validation

7. **`/src/pages/admin/fixtures.astro`**
   - Fixture management UI (upload CSV, add/edit fixtures)
   - Must be created before availability tracking

8. **`/netlify/functions/players-list.ts`**
   - List all players (global pool)
   - Most frequently called function

9. **`/netlify/functions/players-create.ts`**
   - Create new players (global)
   - Validation logic (email, USAC ID uniqueness)

10. **`/src/pages/admin/players.astro`**
    - Main player management UI (global pool)
    - Follows pattern from `/admin/index.astro`

11. **`/netlify/functions/players-import.ts`**
    - Bulk import feature (global)
    - CSV parsing and validation

12. **`/src/pages/admin/players/import.astro`**
    - Import wizard UI
    - Multi-step process

13. **`/netlify/functions/core-roster-list.ts`**
    - List core roster assignments
    - Required for roster management

14. **`/netlify/functions/core-roster-update.ts`**
    - Mark/unmark players as core
    - Core roster management

15. **`/netlify/functions/core-roster-bulk-update.ts`**
    - Bulk update core status
    - Batch operations

16. **`/src/pages/admin/roster.astro`**
    - Team roster management UI
    - Mark/unmark core players per team/season

17. **`/src/pages/admin/availability.astro`**
    - Admin-managed availability tracking interface
    - Two-column grid (available/selected)
    - Uses core roster data

18. **`/netlify/functions/availability-update.ts`**
    - Update availability and selection records
    - Core availability feature

19. **`/netlify/functions/statistics-calculate.ts`**
    - Statistics calculation logic (multi-season)
    - Complex aggregations based on core roster

20. **`/src/pages/admin/statistics.astro`**
    - Statistics dashboard (season/career views)
    - Data visualization

### Files to Reference

- `/src/pages/admin/index.astro` - Table UI, bulk operations, modals
- `/netlify/functions/update-submission.ts` - Blobs CRUD pattern
- `/src/pages/fixtures.astro` - CSV parsing pattern
- `/src/middleware/auth.ts` - Authentication patterns
- `/src/layouts/AdminLayout.astro` - Navigation structure

---

## Future Enhancements (Phase 6+)

### Advanced Features
1. **Email Notifications**
   - Send availability poll reminders
   - Notify players of upcoming fixtures
   - Team announcements

2. **Player Portal** (Public-Facing)
   - Players update their own availability
   - Personal statistics dashboard
   - Team calendar view
   - No admin access required

3. **Advanced Statistics**
   - Charts and graphs (Chart.js or similar)
   - Historical trends
   - Performance metrics (if match results tracked)
   - Season comparisons

4. **Mobile App/PWA**
   - Native mobile experience
   - Push notifications
   - Offline capability

5. **Match Result Tracking**
   - Record match results
   - Link to player statistics
   - Win/loss records per team
   - Individual performance tracking

6. **Photo Management**
   - Player profile photos
   - Team photos
   - Gallery integration

---

## Summary

This plan implements a complete season-based player management system with:

**Core Features:**
- 🗓️ **Season Management**: Create and manage cricket seasons with flexible team formats (T20, T30, T40)
- 👥 **Player Pool Management**: Global player pool with simplified data (Name, Email, USAC ID, Role, Active Status)
- 🏏 **Core Roster Management**: Mark players as core to teams (can be core to multiple teams), manage anytime during season
- ✅ **Admin-Managed Availability**: Admin marks player availability AND selection for each fixture (based on core roster)
- 📈 **Multi-Season Statistics**: Track performance across seasons with availability/selection rates
- 📊 **Career Statistics**: Aggregate player stats across entire career
- 📁 **CSV Import/Export**: Bulk operations for global player pool
- 🔍 **Advanced Filtering**: Search, filter by team/status/role, bulk operations

**Key Design Decisions:**
- ❌ **No player polling**: Admin controls all availability marking (not players)
- ✅ **Global player pool**: Players not tied to specific seasons
- ✅ **Core status per team**: Players marked as "core" to teams, can change anytime during season
- ✅ **Multiple team membership**: Players can be core to multiple teams (different formats)
- ✅ **Flexible teams per season**: Team names/formats can change between seasons
- ✅ **Admin fixture management**: Upload/manage fixtures per season (not single CSV)
- ✅ **Soft delete**: Mark players inactive (keeps historical data)
- ✅ **Two-step tracking**: Availability → Selection (both admin-managed)
- ✅ **Selection rate metric**: Track how often available players get selected
- ✅ **Simplified player data**: Only essential fields (no phone, jersey number, complex assignments)

**Technical Approach:**
- **Storage**: Netlify Blobs (seasons, players, fixture-availability, statistics)
- **Backend**: Netlify Functions (following existing patterns)
- **Frontend**: Astro pages with season-aware UI
- **Auth**: Existing JWT session system
- **CSV Parsing**: PapaParse (already installed)

**Integration:**
- Leverages existing admin infrastructure
- Links to fixture system
- Season-aware navigation throughout
- Follows established design patterns
- Maintains team color coding and branding

**Estimated Timeline:** 5-6 weeks part-time development
- Phase 1 (Season & Fixture Management + Foundation): 2 weeks
- Phase 2 (Import/Export for Players & Fixtures): 4-5 days
- Phase 3 (Admin-Managed Availability): 1 week
- Phase 4 (Multi-Season Statistics): 5-6 days
- Phase 5 (Polish & Testing): 4-5 days
