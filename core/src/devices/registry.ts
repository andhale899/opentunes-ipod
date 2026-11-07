import type { DeviceModel, Source } from './types';

const APPLE_NANO_7G: Source = {
  label: 'Apple Support: iPod nano (7th generation) - Technical Specifications',
  url: 'https://support.apple.com/kb/SP656',
  retrieved: '2026-11-07',
};

/** Identity facts only. Capability limits are added row by row as each model is researched. */
function stub(
  fields: Pick<DeviceModel, 'id' | 'name' | 'family' | 'generation' | 'years' | 'connector' | 'databaseFormat'> & {
    usbProductIds?: number[];
  },
): DeviceModel {
  return {
    ...fields,
    checksum: null,
    media: null,
    verification: 'unverified',
    sources: [],
    notes: [],
  };
}

const nano7g: DeviceModel = {
  id: 'nano-7g',
  name: 'iPod nano (7th generation)',
  family: 'nano',
  generation: '7G',
  years: '2012-2015',
  connector: 'lightning',
  databaseFormat: 'iTunesDB',
  checksum: 'hashAB',
  checksumBasis:
    'The SysInfoExtended of a real nano 7G declares database version 5, which libgpod maps to hashAB (checked by an engine test). Not yet confirmed by a write to hardware.',
  media: {
    music: {
      status: 'supported',
      formats: [
        { codec: 'AAC', bitrateKbps: { min: 8, max: 320 }, variableBitrate: true, maxSampleRateHz: 48000, note: 'AAC-LC' },
        { codec: 'Protected AAC', note: 'iTunes Store purchases' },
        { codec: 'HE-AAC', note: "Listed on Apple's page. The device's own list names AAC-LC only." },
        { codec: 'MP3', bitrateKbps: { min: 8, max: 320 }, variableBitrate: true, maxSampleRateHz: 48000 },
        { codec: 'Apple Lossless', maxSampleRateHz: 48000, maxBitDepth: 16, note: 'Deeper than 16 bits is truncated.' },
        { codec: 'AIFF', maxSampleRateHz: 48000, maxBitDepth: 16 },
        { codec: 'WAV', maxSampleRateHz: 48000, maxBitDepth: 16 },
        { codec: 'Audible', note: 'formats 2, 3, 4, Enhanced Audio, AAX and AAX+' },
      ],
    },
    video: {
      status: 'supported',
      formats: [
        {
          codec: 'h264',
          profiles: ['Baseline', 'Main', 'High'],
          level: '3.0',
          maxWidth: 720,
          maxHeight: 576,
          maxFps: 30,
          maxVideoBitrateKbps: 10000,
          audio: 'AAC-LC up to 256 kbps, 48 kHz, stereo',
          containers: ['.m4v', '.mp4', '.mov'],
        },
        {
          codec: 'h264',
          profiles: ['Baseline'],
          level: '3.0',
          maxWidth: 640,
          maxHeight: 480,
          maxFps: 30,
          maxVideoBitrateKbps: 10000,
          audio: 'AAC-LC up to 256 kbps, 48 kHz, stereo',
          containers: ['.m4v', '.mp4', '.mov'],
        },
        {
          codec: 'mpeg4',
          profiles: ['Simple'],
          maxWidth: 720,
          maxHeight: 576,
          maxFps: 30,
          maxVideoBitrateKbps: 2500,
          audio: 'AAC-LC up to 256 kbps, 48 kHz, stereo',
          containers: ['.m4v', '.mp4', '.mov'],
        },
      ],
      note:
        "Apple's page gives no H.264 bitrate. The device declares 10000 kbps. It lists a second, Baseline-only H.264 entry capped at 640x480, so 640x480 Baseline stays inside both entries and is the safe default. The device declares 5000 kbps for MPEG-4 where Apple's page says 2.5 Mbps, so the lower figure is used.",
    },
    podcast: {
      status: 'supported',
      note: "Not on Apple's page. The device declares podcast support.",
    },
    audiobook: {
      status: 'supported',
      note: 'The page lists Audible formats. M4B files are not mentioned.',
    },
    photo: {
      status: 'supported',
      note: "Not on Apple's page, which lists no photo formats. The device declares photo support with a 480x864 full-screen format and an 80x80 thumbnail. Not confirmed on hardware.",
    },
    notes: { status: 'unknown' },
  },
  deviceDeclared: {
    source: 'engine/data/7_nano_SysInfoExtended.plist',
    note: 'Dumped from a real nano 7G by the author of the upstream TunesReloaded project, not from your unit. Compare it with the SysInfoExtended on your own iPod in Phase 2.',
    volumeFormat: 'FAT32',
    maxTracks: 65534,
    maxFileSizeGB: 4,
    features: { podcasts: true, photos: true, voiceMemos: true, playlistFolders: true, genius: true },
    images: {
      albumArt: [
        { id: 1010, width: 240, height: 240, pixelFormat: 'L565' },
        { id: 1011, width: 240, height: 240, pixelFormat: 'L565' },
        { id: 1013, width: 50, height: 50, pixelFormat: 'L565' },
        { id: 1015, width: 58, height: 58, pixelFormat: 'L565' },
        { id: 1016, width: 57, height: 57, pixelFormat: 'L565' },
      ],
      photo: [
        { id: 1007, width: 480, height: 864, pixelFormat: 'L565' },
        { id: 1005, width: 80, height: 80, pixelFormat: 'L565' },
      ],
      chapter: [
        { id: 1010, width: 240, height: 240, pixelFormat: 'L565' },
        { id: 1019, width: 101, height: 57, pixelFormat: 'L565' },
        { id: 1011, width: 240, height: 240, pixelFormat: 'L565' },
      ],
    },
  },
  usbProductIds: [0x1267],
  observed: [
    {
      date: '2026-11-07',
      source: "Environment check run by the owner on their own nano 7G, macOS, Chrome 157",
      facts: [
        'USB product id 0x1267, manufacturer "Apple Inc.", product name "iPod". The id matches the nano 7th generation in the public USB id list.',
        "The USB serial number string is 16 hex digits starting with Apple's 000A27 prefix. That is the FireWire ID the database signing needs, and Chrome reads it without opening the device.",
        'The volume is labelled IPOD NANO R. It holds a System Volume Information folder (made by Windows) and LOST.DIR (made by Android), which points to a FAT volume that has been mounted by both.',
        'iPod_Control and iPod_Control/Device/SysInfo are present. No file was found at iPod_Control/iTunes/iTunesDB, but the check could not tell a missing folder from a missing file.',
        'Chrome wrote, read back and deleted a two-byte file in the volume top folder. That whole step took 3.7 seconds.',
      ],
    },
    {
      date: '2026-11-07',
      source: 'Second environment check on the same unit, which also listed the files in iPod_Control',
      facts: [
        'iPod_Control/iTunes holds iTunesCDB (216,726 bytes) and no iTunesDB at all. The library is the iTunes Library.itlp folder: Library.itdb (925,696 bytes), Locations.itdb (82,944 bytes) with its Locations.itdb.cbk (1,697 bytes), Dynamic.itdb, Extras.itdb and Genius.itdb. The cbk size is exactly one 57-byte signature, one 20-byte hash and 81 block hashes, which matches the 81 blocks of 1,024 bytes in Locations.itdb.',
        'Also in iPod_Control/iTunes: iTunesPrefs, iTunesPrefs.plist, Rentals.plist, PSElementsAlbums, PSAlbumAlbums, Play Counts (plays logged since the last sync) and .restore_playlist.',
        'iPod_Control/iTunes/iTunesControl and iPod_Control/Device/Radio/RadioBuffer are each exactly 20,971,520 bytes (20 MiB). libgpod never opens either, so the app leaves them out when it loads the database files.',
        'iPod_Control/Device holds SysInfo (52 bytes) and SysInfoExtended (57,556 bytes), plus Radio, Trainer and Bluetooth folders and a few settings files. iPod_Control also holds Music, Artwork, Speakable and iPodPrefs. Music has the folders F00 to F49.',
        'Writing the two-byte test file took 1.49 seconds this time. Closing the writer was 1.47 seconds of that. Creating the file, writing, reading it back and deleting it each took under 10 milliseconds. Chrome appears to flush the volume on every close, so the cost is per file, not per byte.',
      ],
    },
  ],
  verification: 'spec-sourced',
  sources: [APPLE_NANO_7G],
  notes: [
    'Screen is 240 by 432 pixels.',
    'The disk format is FAT32 according to the device template, so Android can mount it. Confirm on your unit.',
    'Album art and photos use the newer ImageSpecifications2 and AlbumArt2 keys, which the 2012 libgpod does not read. Writing artwork needs that added.',
    'Audio tops out at 48 kHz, so 96 kHz or 88.2 kHz files must be resampled.',
    'This family keeps its library in iTunesCDB and an iTunes Library.itlp folder of SQLite files. libgpod reads iTunesCDB first.',
    'The upstream project that the v1 engine came from calls 6th and 7th generation nano support beta.',
  ],
};

export const devices: readonly DeviceModel[] = [
  stub({ id: 'ipod-1g', name: 'iPod (1st generation)', family: 'ipod', generation: '1G', years: '2001', connector: 'firewire', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-2g', name: 'iPod (2nd generation)', family: 'ipod', generation: '2G', years: '2002', connector: 'firewire', databaseFormat: 'iTunesDB', usbProductIds: [0x1202] }),
  stub({ id: 'ipod-3g', name: 'iPod (3rd generation)', family: 'ipod', generation: '3G', years: '2003', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1201] }),
  stub({ id: 'ipod-4g', name: 'iPod (4th generation)', family: 'ipod', generation: '4G', years: '2004', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1203] }),
  stub({ id: 'ipod-photo', name: 'iPod Photo / Color', family: 'photo', generation: 'Photo', years: '2004-2005', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1204] }),
  stub({ id: 'ipod-mini-1g', name: 'iPod mini (1st generation)', family: 'mini', generation: '1G', years: '2004', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1205] }),
  stub({ id: 'ipod-mini-2g', name: 'iPod mini (2nd generation)', family: 'mini', generation: '2G', years: '2005', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1205] }),
  stub({ id: 'ipod-video-5g', name: 'iPod Video (5th generation)', family: 'video', generation: '5G', years: '2005', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1209] }),
  stub({ id: 'ipod-video-5-5g', name: 'iPod Video (5.5 generation)', family: 'video', generation: '5.5G', years: '2006', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1209] }),
  stub({ id: 'ipod-classic-6g', name: 'iPod classic (6th generation)', family: 'classic', generation: '6G', years: '2007-2008', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1261] }),
  stub({ id: 'ipod-classic-7g', name: 'iPod classic (7th generation)', family: 'classic', generation: '7G', years: '2009', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1261] }),
  stub({ id: 'nano-1g', name: 'iPod nano (1st generation)', family: 'nano', generation: '1G', years: '2005', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x120a] }),
  stub({ id: 'nano-2g', name: 'iPod nano (2nd generation)', family: 'nano', generation: '2G', years: '2006', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1260] }),
  stub({ id: 'nano-3g', name: 'iPod nano (3rd generation)', family: 'nano', generation: '3G', years: '2007', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1262] }),
  stub({ id: 'nano-4g', name: 'iPod nano (4th generation)', family: 'nano', generation: '4G', years: '2008', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1263] }),
  stub({ id: 'nano-5g', name: 'iPod nano (5th generation)', family: 'nano', generation: '5G', years: '2009', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1265] }),
  stub({ id: 'nano-6g', name: 'iPod nano (6th generation)', family: 'nano', generation: '6G', years: '2010', connector: '30-pin', databaseFormat: 'iTunesDB', usbProductIds: [0x1266] }),
  nano7g,
  stub({ id: 'shuffle-1g', name: 'iPod shuffle (1st generation)', family: 'shuffle', generation: '1G', years: '2005', connector: 'usb-integrated', databaseFormat: 'iTunesSD', usbProductIds: [0x1300] }),
  stub({ id: 'shuffle-2g', name: 'iPod shuffle (2nd generation)', family: 'shuffle', generation: '2G', years: '2006-2008', connector: 'headphone-jack-usb', databaseFormat: 'iTunesSD', usbProductIds: [0x1301] }),
  stub({ id: 'shuffle-3g', name: 'iPod shuffle (3rd generation)', family: 'shuffle', generation: '3G', years: '2009', connector: 'headphone-jack-usb', databaseFormat: 'iTunesSD', usbProductIds: [0x1302] }),
  stub({ id: 'shuffle-4g', name: 'iPod shuffle (4th generation)', family: 'shuffle', generation: '4G', years: '2010-2017', connector: 'headphone-jack-usb', databaseFormat: 'iTunesSD', usbProductIds: [0x1303] }),
];

export function getDevice(id: string): DeviceModel | undefined {
  return devices.find((device) => device.id === id);
}
