// Site Configuration
// This file contains centralized configuration values used throughout the website

export const SITE_CONFIG = {
    name: 'Golden State Cricket Club',
    location: 'Bay Area, California',
    email: 'gsbengalsinc@gmail.com',
    description: 'Golden State Cricket Club is a part of Bengals Inc. - a 501(c)(3) non-profit organization fostering community connection through cricket across Northern California\'s Bay Area.',

    // Non-Profit Information
    nonProfit: {
        name: 'Bengals Inc.',
        ein: '30-13XXXXX',
        status: '501(c)(3) Tax-Exempt Non-Profit',
        founded: '2018',
        mission: 'To foster a vibrant, inclusive community through the power of sport. We are dedicated to nurturing talent, promoting physical wellness, and inspiring a lifelong passion for excellence, both on and off the field. Our mission extends beyond competitive cricket to building community connections, youth development, and cultural unity.',
        zeffyUrl: 'https://www.zeffy.com/donation-form/XXXXX', // Update with actual Zeffy form URL
        programs: [
            'Competitive Cricket Teams - Three teams competing in NCCA and BACA leagues since 2018',
            'Youth Cricket Development - Free membership for ages 8-18 and full-time students',
            'Player Pathway Program - Supporting members in USA Masters League and USA Minor League',
            'Community Engagement - 160+ members from 8 counties across Bay Area',
            'Inclusive Membership - Removing financial barriers for youth participation',
            'Bay Area Cricket Alliance - Active participation in NCCA leagues (est. 1892)'
        ],
        impactStats: [
            { label: 'Active Members', value: '160+', icon: '🏏' },
            { label: 'Youth & Students', value: '30+', icon: '🎓' },
            { label: 'Counties Represented', value: '8', icon: '🏘️' },
            { label: 'Years of Service', value: '7+', icon: '⏳' }
        ]
    },

    // Social Media Links
    social: {
        instagram: {
            url: 'https://www.instagram.com/goldenstate_cc/',
            label: 'Instagram',
            description: 'Photos and highlights',
            icon: '📷'
        },
        youtube: {
            url: 'https://www.youtube.com/@BengalsCricketClubBayArea',
            label: 'YouTube',
            description: 'Match videos',
            icon: '🎥'
        }
    },

    // Winter Season Check-In Form (/winter-checkin)
    // `isOpen`            → show the link in the site nav (public launch). The page
    //                       still works by direct URL when this is false.
    // `acceptingResponses`→ whether the form accepts submissions at all.
    // Flip `isOpen` to true once the club decides to launch this to everyone.
    winterCheckIn: {
        isOpen: false,
        acceptingResponses: true,
        seasonKey: 'winter-2026-2027',
        seasonLabel: 'Winter 2026–2027',
        seasonWindow: 'October 2026 – March 2027',
        seasonStart: '2026-10-01',
        seasonEnd: '2027-03-31',
        feeNote:
            "We'll confirm the exact amount once we have registration information from NCCA.",
        blackoutNote: 'No games between Dec 15 and Jan 2, or on holiday weekends (Diwali, Halloween, etc.).',
        teams: ['Tigers', 'Bulls', 'ThunderCats'],

        // Shown under "Yes — count me in"; also the checkbox waiver label.
        liabilityText:
            "I'm joining of my own free will and take part at my own risk. Golden State Cricket Club and Bengals Inc. aren't liable for any injury, illness, or loss arising from my participation.",

        // Summer '26 season feedback — a member-only block on the same form,
        // reviewed on its own admin page (/admin/summer-feedback).
        summerFeedback: {
            enabled: true,
            seasonLabel: 'Summer 2026',
            adminLabel: "Summer '26 Feedback",
            teams: ['Tigers', 'Bulls', 'Thunder Cats', 'Bears'],
            leadership: {
                Tigers: { captain: 'Likith Gowda', viceCaptain: 'Rahul Radhakrishna' },
                Bulls: { captain: 'Ajinkya Thakare', viceCaptain: 'Dhruv Patel' },
                'Thunder Cats': { captain: '', viceCaptain: '' },
                Bears: {
                    captain: 'Mazher Khan',
                    viceCaptain: 'Abhishek Santhanam, then Ratik Sachdeva (2nd half)'
                }
            } as Record<string, { captain: string; viceCaptain: string }>
        }
    }
};

// Sponsorship Configuration
export const SPONSORS = {
    tiers: [
        {
            id: 'platinum',
            name: 'Platinum Sponsor',
            color: 'platinum' as const,
            benefits: [
                '"Brand" logo on both front and back of jersey',
                '"Brand" promotion on social media channel',
                'Invitation to annual member gathering',
                'Member activation (minimum 3 times per season)'
            ]
        },
        {
            id: 'gold',
            name: 'Gold Sponsor',
            color: 'gold' as const,
            benefits: [
                '"Brand" logo on side sleeve of jersey (one sleeve)',
                'Member activation (1 time per season)'
            ]
        }
    ],

    current: [
        {
            name: 'Dimple Sheth',
            tier: 'platinum' as const,
            description: 'Real Estate Agent, Bay Area',
            logo: '/sponsors/dimple-seth.png',
            website: '#',
            year: 2026
        },
        {
            name: 'Parktown Pizza Company',
            tier: 'gold' as const,
            description: 'India Fusion Pizza & Wings with 5 Outlets in Bay Area',
            logo: '/sponsors/parktown.png',
            website: '#',
            year: 2026
        },
        {
            name: 'NACL Sports Center',
            tier: 'gold' as const,
            description: 'Practice & Ground Sponsor',
            logo: '/sponsors/nacl.png',
            website: '#',
            year: 2026
        }
    ],

    past: [
        {
            name: 'MAZALA Pizza',
            tier: 'platinum' as const,
            description: 'Indian Pizza, Chicago-based, first store in Downtown San Jose',
            years: [2025],
            logo: '/sponsors/mazala.png'
        },
        {
            name: 'Parktown Pizza Company',
            tier: 'platinum' as const,
            description: 'India Fusion Pizza & Wings with 5 Outlets in Bay Area',
            years: [2023, 2024],
            logo: '/sponsors/parktown.png'
        },
        {
            name: 'Realty ++',
            tier: 'platinum' as const,
            description: 'Real Estate Broker & Realtor, Fremont Bay Area',
            years: [2022],
            logo: '/sponsors/realty.png'
        },
        {
            name: 'Parktown Pizza',
            tier: 'gold' as const,
            description: 'India Fusion Pizza & Wings with 5 Outlets in Bay Area',
            years: [2022],
            logo: '/sponsors/parktown.png'
        },
        {
            name: 'Ascend Technology Inc',
            tier: 'gold' as const,
            description: 'IT Managed Services Company, San Jose, Bay Area',
            years: [2022, 2023, 2024],
            logo: '/sponsors/ascend.png'
        },
        {
            name: 'T10 Sports',
            tier: 'gold' as const,
            description: 'Official Jersey & Kit Partner',
            years: [2023, 2024, 2025],
            logo: '/sponsors/t10.png'
        },
        {
            name: 'NACL Sports Center',
            tier: 'gold' as const,
            description: 'Practice & Ground Sponsor',
            years: [2024, 2025],
            logo: '/sponsors/nacl.png'
        }
    ],

    benefits: {
        why: [
            {
                title: 'Brand Visibility',
                description: 'Support local community while gaining exposure across 8 Bay Area counties'
            },
            {
                title: 'Social Media Presence',
                description: 'Tagging sponsors on all communications across Instagram and YouTube channels'
            }
        ],
        what: [
            {
                title: 'Promotional Campaigns',
                description: 'Run targeted campaigns to our exclusive club members'
            },
            {
                title: 'Target Member Connections',
                description: 'Access to corporate connections and student community (SJSU and Santa Clara University)'
            },
            {
                title: 'Community Events',
                description: 'Ability to support cross-community events and gain local recognition'
            }
        ],
        where: [
            'Team Jerseys',
            'Social Media Communications',
            'YouTube Live Stream',
            'Club Events',
            'Event Hosting Opportunities'
        ]
    }
};
