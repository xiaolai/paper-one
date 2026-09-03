//! Length-prefixed frames on a QUIC stream: `u32` big-endian length, then
//! that many bytes. The cap is 4 MiB; a declared length above it closes the
//! stream's session before a byte of it is allocated.
//!
//! Control messages (the plugin hello, pairing, blob request/header) are JSON
//! in a frame; everything the app sends is an opaque frame. The functions are
//! generic over tokio's `AsyncRead`/`AsyncWrite`, which iroh's `RecvStream`
//! and `SendStream` implement — so they are tested here on an in-memory
//! duplex and used unchanged on the wire.

use bytes::Bytes;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{Error, Result};

/// The largest frame either side will read.
pub const MAX_FRAME: u32 = 4 * 1024 * 1024;

/// Read one frame. `Ok(None)` when the stream ended cleanly at a frame
/// boundary; an EOF inside a frame is an error.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Bytes>> {
    read_capped(reader, MAX_FRAME).await
}

/// One frame, under a cap this caller chose.
///
/// ⚠️ **THE CAP IS CHECKED AGAINST THE DECLARED LENGTH BEFORE THE BODY IS READ
/// OR ALLOCATED**, which is the whole point of taking it as a parameter. A
/// door a stranger can open — `circle::CIRCLE_HELLO_ALPN` — must not be
/// willing to allocate `MAX_FRAME`'s four megabytes because a peer said it
/// would send that much; it says 64 KiB and the refusal happens before a byte
/// of body moves.
///
/// `read_frame` is this with the transport-wide cap, so there is one
/// implementation of "read a length-prefixed frame" rather than two that can
/// drift about whether the length is checked first.
pub async fn read_capped<R: AsyncRead + Unpin>(reader: &mut R, max: u32) -> Result<Option<Bytes>> {
    let mut len_buf = [0u8; 4];
    match reader.read(&mut len_buf[..1]).await? {
        0 => return Ok(None),
        _ => reader.read_exact(&mut len_buf[1..]).await?,
    };
    let len = u32::from_be_bytes(len_buf);
    if len > max {
        return Err(Error::FrameTooLarge { size: len, max });
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).await?;
    Ok(Some(Bytes::from(buf)))
}

/// Write one frame. Refuses to send what the other side would refuse.
pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, payload: &[u8]) -> Result<()> {
    let len = u32::try_from(payload.len())
        .ok()
        .filter(|&len| len <= MAX_FRAME)
        .ok_or(Error::FrameTooLarge {
            size: payload.len().min(u32::MAX as usize) as u32,
            max: MAX_FRAME,
        })?;
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(payload).await?;
    Ok(())
}

/// Read a frame and parse it as JSON.
pub async fn read_json<R: AsyncRead + Unpin, T: DeserializeOwned>(reader: &mut R) -> Result<T> {
    let frame = read_frame(reader)
        .await?
        .ok_or_else(|| Error::FrameMalformed("stream ended before the control frame".into()))?;
    serde_json::from_slice(&frame).map_err(|e| Error::FrameMalformed(e.to_string()))
}

/// Serialize as JSON and write as one frame.
pub async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| Error::FrameMalformed(e.to_string()))?;
    write_frame(writer, &bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trips_frames_in_order() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_frame(&mut a, b"hello").await.unwrap();
        write_frame(&mut a, b"").await.unwrap();
        write_frame(&mut a, &[7u8; 300]).await.unwrap();
        drop(a);
        assert_eq!(read_frame(&mut b).await.unwrap().unwrap(), &b"hello"[..]);
        assert_eq!(read_frame(&mut b).await.unwrap().unwrap(), &b""[..]);
        assert_eq!(read_frame(&mut b).await.unwrap().unwrap(), &[7u8; 300][..]);
        assert!(read_frame(&mut b).await.unwrap().is_none(), "clean end");
    }

    #[tokio::test]
    async fn an_oversized_declared_length_is_refused_before_allocation() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        // 4 GiB declared, four bytes sent. Were the reader to allocate the
        // declared length it would either fail the allocation or hang
        // waiting; instead the length check fires from the header alone.
        a.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
        let err = read_frame(&mut b).await.unwrap_err();
        assert_eq!(err.kind(), "frameTooLarge");
        assert!(err.to_string().contains(&u32::MAX.to_string()));
    }

    #[tokio::test]
    async fn exactly_the_cap_is_allowed_and_one_more_is_not() {
        let (mut a, mut b) = tokio::io::duplex(64);
        tokio::spawn(async move {
            a.write_all(&(MAX_FRAME + 1).to_be_bytes()).await.unwrap();
        });
        assert_eq!(
            read_frame(&mut b).await.unwrap_err().kind(),
            "frameTooLarge"
        );

        let (mut a, _b) = tokio::io::duplex(64);
        let too_big = vec![0u8; MAX_FRAME as usize + 1];
        assert_eq!(
            write_frame(&mut a, &too_big).await.unwrap_err().kind(),
            "frameTooLarge"
        );
    }

    #[tokio::test]
    async fn eof_inside_a_frame_is_an_error() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(b"abc").await.unwrap();
        drop(a);
        assert_eq!(read_frame(&mut b).await.unwrap_err().kind(), "io");
    }

    #[tokio::test]
    async fn json_frames_round_trip_and_garbage_is_typed() {
        #[derive(Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Msg {
            kind: String,
            n: u32,
        }
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_json(
            &mut a,
            &Msg {
                kind: "hello".into(),
                n: 3,
            },
        )
        .await
        .unwrap();
        write_frame(&mut a, b"{not json").await.unwrap();
        drop(a);
        let msg: Msg = read_json(&mut b).await.unwrap();
        assert_eq!(msg.n, 3);
        assert_eq!(
            read_json::<_, Msg>(&mut b).await.unwrap_err().kind(),
            "frameMalformed"
        );
        assert_eq!(
            read_json::<_, Msg>(&mut b).await.unwrap_err().kind(),
            "frameMalformed",
            "a clean end where a control frame was due is malformed, not None"
        );
    }

    #[tokio::test]
    async fn a_frame_exactly_at_the_cap_is_allowed() {
        /* ⚠️ **THE BOUNDARY WAS ONLY EVER TESTED FROM ABOVE.** Both existing
        cases use `MAX + 1`, so changing the check to `len >= max` — off by one
        in the refusing direction — left them green while every frame exactly at
        the limit started failing. A cap that cannot be reached is a different
        cap. */
        const CAP: u32 = 64;
        let mut wire = Vec::new();
        write_frame(&mut wire, &vec![7u8; CAP as usize])
            .await
            .unwrap();

        let got = read_capped(&mut wire.as_slice(), CAP).await.unwrap();

        assert_eq!(got.map(|b| b.len()), Some(CAP as usize));
    }

    #[tokio::test]
    async fn one_byte_over_the_cap_is_refused() {
        const CAP: u32 = 64;
        let mut wire = Vec::new();
        write_frame(&mut wire, &vec![7u8; CAP as usize + 1])
            .await
            .unwrap();

        assert!(read_capped(&mut wire.as_slice(), CAP).await.is_err());
    }
}
