use cpeak::crypto::base64url_encode;

// The properties of a type of link whose codes we generate ourselves
pub struct Link {
    pub characters: &'static str,
    pub max_length: usize,
    pub min_length: usize,

    pub requires_auth: bool,
    pub conversions: &'static [(&'static str, &'static str)],
    pub valid_for: Option<i64>,
}

pub struct Empty {}

pub struct Qr {
    // (the function that writes the random bytes as text)
    pub character_encoding: fn(Vec<u8>) -> String,
    pub length: usize,
    pub size: usize,
}

pub struct Links {
    pub classic: Link,
    pub ultra: Link,
    pub digit: Link,
    pub custom: Empty,
    pub affix: Empty,
    pub qr: Qr,
}

/* @TODO maybe send this data to client for the customization model to show the data dynamically */
// This should be our single source of truth for link types and their properties
pub const LINKS: Links = Links {
    classic: Link {
        // name: "6-Character Code",
        // example: "Example: <span>weer.pro/f3hc42</span>",
        // description: `This code contains only lowercase letters and numbers. Don't worry about your audience typing uppercase or lowercase, we'll handle that for you. Great if you just want a shorten link, don't want to worry about your link expiring, selecting anything and even creating an account!`,

        // Total combinations: 34^6  = 1,544,804,416 (around 1.5 billion combinations)
        characters: "abcdefghijkmnpqrstuvwxyz0123456789", // no o or l to avoid confusion
        max_length: 6,
        min_length: 6,

        requires_auth: false,
        conversions: &[
            // This means convert the 'key' property to the 'value' property when redirecting (e.g. O -> 0, l -> i)
            ("o", "0"),
            ("l", "i"),
        ],
        valid_for: None, // permanent
    },
    ultra: Link {
        // name: "Ultra Short Code (1–2 Characters)",
        // example: "Examples: weer.pro/6 or weer.pro/1a",
        // description: `Our magical shortest possible option, perfect for saying it out loud. Imagine you’re on a call, just say “Go to weer.pro/d, it’s my demo link,” and that's it. Keep in mind that your link will be <strong>public</strong> and valid for <strong>only 30 minutes</strong> and after someone else will claim it.`,

        // Total combinations: 34^1 + 34^2 = 1,190 combinations
        characters: "0123456789abcdefghijkmnpqrstuvwxyz", // no o or l to avoid confusion
        max_length: 2,
        min_length: 1,

        requires_auth: true,
        conversions: &[
            /*
             * Ultra codes do not use o or l, but in case user enters them, we will convert them
             * to 0 and i respectively for better user experience.
             */
            // This means convert the 'key' property to the 'value' property when redirecting (e.g. O -> 0, l -> i)
            ("o", "0"),
            ("l", "i"),
        ],
        valid_for: Some(30 * 60 * 1000), // 30 minutes in milliseconds
    },
    digit: Link {
        // name: "Short Numeric Code (3-5 Digits)",
        // example: "Example: <span>weer.pro/5322</span>",
        // description: `Great if you quickly want to share a link with others during a presentation! Keep in mind that your link will be valid for <strong>only 2 hours</strong> and after someone else might claim it.`,

        // Total combinations: 10^3 + 10^4 + 10^5 = 111,000 combinations
        characters: "0123456789", // no o or l to avoid confusion
        max_length: 5,
        min_length: 3,

        requires_auth: false,
        conversions: &[
            /*
             * Digit codes do not use any letters, but in case user enters them, we will try convert them
             * to digits for better user experience.
             */
            // This means convert the 'key' property to the 'value' property when redirecting (e.g. O -> 0)
            ("o", "0"),
        ],
        valid_for: Some(2 * 60 * 60 * 1000), // 2 hours in milliseconds
    },
    custom: Empty {},
    affix: Empty {},
    qr: Qr {
        character_encoding: base64url_encode, // using base64url to avoid special characters
        length: 10,                           // 10 characters long when in base64url (7 bytes)
        size: 7,                              // 7 bytes = 56 bits of entropy
    },
};
