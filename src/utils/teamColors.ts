// Team pill colors on the public schedule (/fixtures), shared by match and umpiring cards
export function getTeamColor(teamName: string): { bg: string; border: string; color: string } {
    if (teamName.includes('Tigers')) return { bg: '#fef3c7', border: '#fcd34d', color: '#78350f' };
    if (teamName.includes('Bulls')) return { bg: '#dbeafe', border: '#93c5fd', color: '#1e40af' };
    if (teamName.includes('Thunder')) return { bg: '#f3e8ff', border: '#d8b4fe', color: '#6b21a8' };
    if (teamName.includes('Bears')) return { bg: '#dcfce7', border: '#86efac', color: '#166534' };
    return { bg: '#f3f4f6', border: '#d1d5db', color: '#1f2937' };
}
