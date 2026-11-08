/** What the guide shows as a tree. Kept as text so it can be read, copied and checked by a test. */
export const FOLDER_TREE = `Music/
  Artist/
    Album/
      01 Title.mp3
Audiobooks/
  Author/
    Book Title/
      01 Chapter.mp3
      (or one file: Book Title.m4b)
Podcasts/
  Show Name/
    2026-01-05 Episode.mp3
Movies/
  Title (Year).mp4
TV Shows/
  Show Name/
    Season 1/
      S01E02 Title.mp4
Music Videos/
  Artist/
    Title.mp4`;

/**
 * 'How to arrange your files': a collapsible guide for the Add music tab. The rules it describes
 * are in folderRules.ts and the formats come from the device registry (the nano 7th generation's
 * limits), so change them together.
 */
export function FolderGuide({ open = false }: { open?: boolean }) {
  return (
    <details class="guide" open={open}>
      <summary>How to arrange your files</summary>
      <div class="guide-body">
        <p>
          You can pick a whole folder in "Choose a folder". OpenTunes reads the folder names to guess what each file is and to fill in names the file does not have. Arrange the folder like this:
        </p>
        <pre class="tree" aria-label="Folder layout">
          {FOLDER_TREE}
        </pre>
        <p class="muted">
          Pick the top folder that holds these, or pick one of them on its own, such as "Audiobooks". Its name counts too. Capital letters do not matter. Other names work as well: Songs, Audio Books, Books, Films, TV, Series, Shows.
        </p>

        <h4>What the app reads from the names</h4>
        <ul>
          <li>
            <strong>Music:</strong> the artist and album from the two folders, and the track number from a number at the start of the file name ("01 Title.mp3", "01 - Title.mp3"). A "Disc 2" folder inside an album sets the disc.
          </li>
          <li>
            <strong>Audiobooks:</strong> the author from the first folder and the book from the last. Chapters are ordered by the number at the start of the file name. One .m4b file for the whole book works too.
          </li>
          <li>
            <strong>Podcasts:</strong> the show from the folder. A date at the start of the file name ("2026-01-05 Episode.mp3") becomes the year and is taken out of the title.
          </li>
          <li>
            <strong>Movies:</strong> "Title (Year).mp4" gives the title and the year.
          </li>
          <li>
            <strong>TV shows:</strong> the show from its folder, the season from a "Season 1" folder, and the episode from S01E02 or 1x02 in the file name. The file name wins over the folder for the season.
          </li>
          <li>
            <strong>Music videos:</strong> the artist from the folder.
          </li>
        </ul>
        <p>
          The kind is set from the folder name, and you can change it for any file in the list. A file whose own tags already say the title, artist, album and so on keeps them: folder and file names only fill in what is missing.
        </p>

        <h4>What the iPod plays as it is, and what is converted</h4>
        <p>These are the limits of the iPod nano 7th generation. Another model has its own limits, and the list shows what will happen to each file before anything is written.</p>
        <ul>
          <li>
            <strong>Copied as they are:</strong> MP3 and AAC (M4A, M4B) up to 320 kbps and 48 kHz, Apple Lossless, and WAV and AIFF at 16 bits and up to 48 kHz. Video in H.264, up to 720 by 576, in .m4v, .mp4 or .mov.
          </li>
          <li>
            <strong>Converted in this page:</strong> FLAC, Ogg, Opus and WMA, audio above the limits (a higher sample rate, or 24 bits), and video in other formats such as HEVC, VP9 or MKV. Audio is converted to AAC and video to H.264. It takes a while, and a large batch can fill the tab's memory, so add big folders in groups.
          </li>
          <li>
            <strong>Left out, with a reason:</strong> AV1 video, copy-protected files, and books and documents (the iPod has nowhere to put them).
          </li>
        </ul>

        <h4>One file cannot be bigger than 4 GB</h4>
        <p>
          The iPod stores files on a FAT32 disk, which cannot hold a single file of 4 GB or more. A bigger file is skipped and the list says so. Split it, or make a smaller copy first.
        </p>

        <h4>Tags in the file win over folder names</h4>
        <p>
          If a file already has an artist, album, title, track number or show tag, that is what goes on the iPod, even when the folder says something else. If a name on the iPod looks wrong, fix the tags in the file, or change the track afterwards in the Library tab.
        </p>
      </div>
    </details>
  );
}
