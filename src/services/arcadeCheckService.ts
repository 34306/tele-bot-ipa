import axios from 'axios';

export class ArcadeCheckService {
  private checkUrl: string;

  constructor(checkUrl: string = 'http://localhost:8080/check-arcade.php') {
    this.checkUrl = checkUrl;
  }

  /**
   * Check if app is Apple Arcade or paid app
   * Returns { isArcade: boolean, isFree: boolean, isPaid: boolean }
   */
  async checkApp(url: string, country: string = 'us'): Promise<{
    isArcade: boolean;
    isFree: boolean;
    isPaid: boolean;
  }> {
    try {
      const response = await axios.post(
        this.checkUrl,
        { url, country },
        {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.data || !response.data.ok) {
        // If check fails, assume it's free (don't block)
        console.warn(`[ArcadeCheckService] Check failed: ${response.data?.error || 'Unknown error'}`);
        return { isArcade: false, isFree: true, isPaid: false };
      }

      const { is_arcade, is_free } = response.data;
      const isPaid = !is_free && !is_arcade;

      return {
        isArcade: is_arcade === true,
        isFree: is_free === true,
        isPaid: isPaid,
      };
    } catch (error: any) {
      // If PHP server is not running or check fails, assume it's free (don't block)
      console.warn(`[ArcadeCheckService] Check error: ${error.message}`);
      return { isArcade: false, isFree: true, isPaid: false };
    }
  }
}
